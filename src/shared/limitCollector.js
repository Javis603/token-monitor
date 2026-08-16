'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appVersion } = require('./appVersion');
const { BROWSER_USER_AGENT } = require('./browserUserAgent');
const { LIMIT_PROVIDER_IDS } = require('./limitProviders');
const {
  DEFAULT_LIMITS_REFRESH_MS,
  normalizeLimitProvider,
  normalizeLimitsSummary,
  openCodeWindowKey
} = require('./limits');
const { parseRetryAfterHeader } = require('./limitsRetryPolicy');
const { abortError } = require('./probeDeadline');
const cursorAuth = require('./cursorAuth');
const cursorProbe = require('./cursorProbe');
const antigravityProbe = require('./antigravityProbe');
const opencodeLimits = require('./opencodeLimits');
const opencodeGoApi = require('./opencodeGoApi');
const opencodeProfiles = require('./opencodeProfiles');
const opencodeWeb = require('./opencodeWeb');
const openrouterLimits = require('./openrouterLimits');
const thirdPartyLimits = require('./thirdPartyLimits');
const { sharedDataDir } = require('./config');
const { recordConsumption } = require('./deepseekBalanceHistory');
const { codexAccountKey, codexAuthIdentity } = require('./codexAuth');
const minimaxLimits = require('./minimaxLimits');
const { minimaxToken, minimaxBaseUrl, parseMinimaxTiers, fetchMinimaxLimits } = minimaxLimits;
const mimoLimits = require('./mimoLimits');
const { fetchMimoLimits } = mimoLimits;
const grokLimits = require('./grokLimits');
const copilotLimits = require('./copilotLimits');
const { copilotToken, fetchCopilotLimits } = copilotLimits;
const kiroLimits = require('./kiroLimits');
const { parseKiroUsage, fetchKiroLimits } = kiroLimits;
const zaiLimits = require('./zaiLimits');
const { zaiToken, zaiRegion, fetchZaiLimits } = zaiLimits;
const zaiTeamLimits = require('./zaiTeamLimits');
const { fetchZaiTeamLimits, zaiTeamToken } = zaiTeamLimits;
const volcengineLimits = require('./volcengineLimits');
const { volcengineCredentials, fetchVolcengineLimits } = volcengineLimits;
const qoderLimits = require('./qoderLimits');
const { qoderCookie, fetchQoderLimits } = qoderLimits;
const commandcodeLimits = require('./commandcodeLimits');
const { commandcodeCookie, fetchCommandcodeLimits } = commandcodeLimits;
const ollamaLimits = require('./ollamaLimits');
const { ollamaSessionCookie, fetchOllamaLimits } = ollamaLimits;
const kimiLimits = require('./kimiLimits');
const { kimiToken, kimiWebToken, fetchKimiLimits } = kimiLimits;
const {
  grokCredential,
  readAuthJson,
  parseGrokBilling,
  parseGrokGrpcWebBilling,
  fetchGrokRpcBilling,
  fetchGrokWebGrpcBilling,
  fetchGrokLimits
} = grokLimits;

const DEFAULT_PROVIDER_PHYSICAL_BOUND_MS = 120_000;
const PROVIDER_CLEANUP_GRACE_MS = 5_000;
const LIMIT_REFRESH_VALUES = new Set([60_000, 120_000, 300_000, 900_000, 1_800_000]);
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const CLAUDE_WEB_BASE_URL = 'https://claude.ai';
const CLAUDE_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const CLAUDE_IDENTITY_CACHE_TTL_MS = 60 * 60 * 1000;
const CLAUDE_IDENTITY_CACHE_MAX_ENTRIES = 16;
const CLAUDE_IDENTITY_CACHE_STATE_KEY = 'claude.identity-cache';
// A prepaid credit pool only moves when credits are spent or a grant expires, so
// it is refreshed far less often than usage. Without this the steady-state Web
// refresh would cost two requests instead of the documented one.
const CLAUDE_PREPAID_CACHE_TTL_MS = 10 * 60 * 1000;
const CLAUDE_PREPAID_IDLE_TTL_FACTOR = 6;
const CLAUDE_PREPAID_CACHE_STATE_KEY = 'claude.prepaid-cache';
const CLAUDE_SESSION_WINDOW_MINUTES = 5 * 60;
const CLAUDE_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const CODEX_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_RESET_CREDITS_PATH = '/wham/rate-limit-reset-credits';
const CODEX_EMPTY_QUOTA_RETRY_DELAY_MS = 300;
const CODEX_RPC_TIMEOUT_MS = 20_000;
const TOKEN_MONITOR_USER_AGENT = `token-monitor/${appVersion()} (+https://github.com/Javis603/token-monitor)`;

function nowIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseLimitProviders(value) {
  const isEmpty = value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0);
  const source = isEmpty ? LIMIT_PROVIDER_IDS : value;
  const raw = Array.isArray(source) ? source : String(source).split(',');
  const seen = new Set();
  const providers = [];
  for (const item of raw) {
    const provider = String(item || '').trim().toLowerCase();
    if (!LIMIT_PROVIDER_IDS.includes(provider) || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  return providers;
}

function normalizeLimitsRefreshMs(value) {
  const parsed = Number(value);
  if (LIMIT_REFRESH_VALUES.has(parsed)) return parsed;
  return DEFAULT_LIMITS_REFRESH_MS;
}

// A scheduling policy, kept separate from limitsRefreshMs so that switching to
// adaptive and back restores the interval the user had chosen, and so that no
// consumer doing arithmetic on limitsRefreshMs has to handle a sentinel value.
function normalizeLimitsRefreshMode(value) {
  return String(value ?? '').trim().toLowerCase() === 'adaptive' ? 'adaptive' : 'fixed';
}

function hashKey(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(String(part || '')).update('\0');
  return `sha256:${hash.digest('hex')}`;
}

function errorWithStatus(status, message) {
  const error = new Error(message || status);
  error.status = status;
  return error;
}

function shouldTryClaudeCliFallback(error) {
  return ['notConfigured', 'sourceRateLimited', 'unavailable', 'error'].includes(error?.status);
}

function normalizeClaudeWebCookie(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (/[\s;]/.test(raw)) return '';
  const sessionKey = raw.startsWith('sessionKey=') ? raw.slice('sessionKey='.length) : raw;
  return sessionKey.startsWith('sk-ant-') && sessionKey.length > 'sk-ant-'.length
    ? `sessionKey=${sessionKey}`
    : '';
}

function normalizeClaudeWebCookieInput(value) {
  const raw = typeof value === 'string' ? value : String(value || '');
  const normalized = normalizeClaudeWebCookie(raw);
  if (raw.trim() && !normalized) {
    const error = new Error('Claude Web sessionKey must be an sk-ant- value');
    error.code = 'INVALID_CLAUDE_WEB_SESSION_KEY';
    throw error;
  }
  return normalized;
}

// Reading the prepaid pool is a scope step beyond the quota data the Web cookie
// was supplied for, so it stays switchable. Default on: the account gate above
// already limits it to people who deliberately enabled usage credits.
function claudePrepaidBalanceEnabled(env = process.env, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'claudePrepaidBalanceEnabled')) {
    return options.claudePrepaidBalanceEnabled !== false;
  }
  const configured = env.TOKEN_MONITOR_CLAUDE_PREPAID_BALANCE;
  return configured === undefined || configured === '' ? true : parseBoolean(configured, true);
}

function claudeWebCookie(env = process.env, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'claudeWebCookie')) {
    return normalizeClaudeWebCookie(options.claudeWebCookie);
  }
  return normalizeClaudeWebCookie(env.CLAUDE_WEB_COOKIE);
}

async function readJsonFile(filePath, deps) {
  const readFile = deps.readFile || fs.promises.readFile;
  const text = await readFile(filePath, 'utf8');
  return JSON.parse(text);
}

function claudeCredentialPath(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, '.credentials.json');
}

function normalizeExpiresAt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 20_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function listWslDistros(deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  try {
    return readdirSync('\\\\wsl$').filter((name) => name && !name.startsWith('.') && !name.includes('$'));
  } catch (_) {
    return [];
  }
}

function wslClaudeCredentialPaths(deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const paths = [];
  for (const distro of listWslDistros(deps)) {
    const homeDir = `\\\\wsl$\\${distro}\\home`;
    let users;
    try { users = readdirSync(homeDir); } catch (_) { continue; }
    for (const user of users) {
      paths.push(`\\\\wsl$\\${distro}\\home\\${user}\\.claude\\.credentials.json`);
    }
  }
  return paths;
}

async function rankClaudeCredentialFiles(deps = {}) {
  const env = deps.env || process.env;
  const statFn = deps.stat || fs.promises.stat;
  const platform = deps.platform || process.platform;
  const candidates = [];
  const nativePath = deps.claudeCredentialPath || claudeCredentialPath(env);
  candidates.push({
    path: nativePath,
    identityLabel: env.CLAUDE_CONFIG_DIR ? 'CLAUDE_CONFIG_DIR/.credentials.json' : '~/.claude/.credentials.json'
  });
  if (platform === 'win32' && !env.CLAUDE_CONFIG_DIR) {
    for (const wslPath of wslClaudeCredentialPaths(deps)) {
      candidates.push({
        path: wslPath,
        identityLabel: `wsl:${wslPath.slice(7).replace(/\\\.claude\\\.credentials\.json$/, '')}`
      });
    }
  }
  const stamped = [];
  for (const candidate of candidates) {
    try {
      const stats = await statFn(candidate.path);
      stamped.push({ ...candidate, mtimeMs: stats.mtimeMs });
    } catch (_) {}
  }
  return stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function codexAuthPath(env = process.env) {
  const base = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(base, 'auth.json');
}

function envValue(env = {}, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function pathApiForPlatform(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function displayPlanWord(word) {
  const raw = String(word || '');
  const lower = raw.toLowerCase();
  if (['ai', 'api', 'cbp', 'gpt', 'k12'].includes(lower)) return lower.toUpperCase();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function cleanPlanText(text, prefixes = ['claude', 'chatgpt', 'openai']) {
  const raw = String(text || '').trim();
  if (!raw || raw.includes('@')) return '';
  const prefixPattern = prefixes.length > 0 ? new RegExp(`^(?:${prefixes.join('|')})[\\s_-]+`, 'i') : null;
  let clean = raw;
  while (prefixPattern && prefixPattern.test(clean)) clean = clean.replace(prefixPattern, '');
  return clean
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function displayPlanText(raw, maxWords = 3) {
  const words = String(raw || '').split(/\s+/).filter(Boolean);
  const visible = Number.isFinite(maxWords) ? words.slice(0, maxWords) : words;
  return visible.map(displayPlanWord).join(' ');
}

const PLAN_LABEL_ALIASES = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  teams: 'Team',
  enterprise: 'Enterprise',
  ultra: 'Ultra'
};

function planLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '')).find(Boolean) || '';
  const raw = cleanPlanText(text);
  if (!raw || raw.includes('@')) return '';
  if (PLAN_LABEL_ALIASES[raw]) return PLAN_LABEL_ALIASES[raw];
  return displayPlanText(raw);
}

function claudeRateLimitTierLabel(rateLimitTier) {
  const raw = cleanPlanText(rateLimitTier, []);
  if (!raw) return '';
  // `raven` is the internal codename an enterprise tier carries (`default_raven`),
  // not something to render: without it that tier would read as a plan called Raven.
  const words = raw.split(/\s+/).filter((word) => !['default', 'claude', 'ai', 'raven'].includes(word));
  if (words.length === 0) return '';
  return planLabelFromParts(words.join(' '));
}

function claudePlanLabelFromParts(subscriptionType, rateLimitTier) {
  const subscriptionLabel = planLabelFromParts(subscriptionType);
  const tierLabel = claudeRateLimitTierLabel(rateLimitTier);
  if (subscriptionLabel === 'Max' && /^Max\s+(?:5x|20x)$/i.test(tierLabel)) return tierLabel;
  return subscriptionLabel || tierLabel;
}

function codexPlanLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '').trim()).find(Boolean) || '';
  if (!text || text.includes('@')) return '';
  const exact = {
    pro: 'Pro 20x',
    prolite: 'Pro 5x',
    pro_lite: 'Pro 5x',
    'pro-lite': 'Pro 5x',
    'pro lite': 'Pro 5x'
  };
  const raw = text.toLowerCase();
  if (exact[raw]) return exact[raw];
  const cleaned = cleanPlanText(text, ['codex', 'chatgpt', 'openai']);
  if (!cleaned) return '';
  if (exact[cleaned]) return exact[cleaned];
  const aliases = {
    free: 'Free',
    plus: 'Plus',
    max: 'Max',
    team: 'Team',
    teams: 'Team',
    enterprise: 'Enterprise',
    'enterprise cbp usage based': 'Enterprise',
    'self serve business usage based': 'Business'
  };
  if (aliases[cleaned]) return aliases[cleaned];
  return displayPlanText(cleaned, Infinity);
}

function antigravityPlanLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '').trim()).find(Boolean) || '';
  const raw = cleanPlanText(text, ['google', 'ai']);
  if (!raw) return '';
  return planLabelFromParts(raw);
}

function extractClaudeOauth(credentials) {
  return credentials?.claudeAiOauth || credentials?.oauth || credentials || null;
}

function claudeCredentialsFromOauth(oauth, meta = {}) {
  if (!oauth?.accessToken) return null;
  return {
    source: meta.source || '',
    filePath: meta.filePath,
    fileShape: meta.fileShape,
    accessToken: String(oauth.accessToken),
    refreshToken: oauth.refreshToken ? String(oauth.refreshToken) : null,
    expiresAt: normalizeExpiresAt(oauth.expiresAt),
    identity: meta.identity || `${meta.source || 'claude'}:${oauth.subscriptionType || ''}:${oauth.rateLimitTier || ''}`,
    accountLabel: claudePlanLabelFromParts(oauth.subscriptionType, oauth.rateLimitTier)
  };
}

async function readClaudeCredentials(deps = {}) {
  const env = deps.env || process.env;
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      source: 'env',
      accessToken: String(env.CLAUDE_CODE_OAUTH_TOKEN),
      refreshToken: null,
      expiresAt: null,
      identity: 'env:CLAUDE_CODE_OAUTH_TOKEN',
      accountLabel: ''
    };
  }

  for (const candidate of await rankClaudeCredentialFiles(deps)) {
    try {
      const raw = await readJsonFile(candidate.path, deps);
      const fileShape = raw && typeof raw === 'object' && raw.claudeAiOauth ? 'claudeAiOauth' : 'root';
      const oauth = extractClaudeOauth(raw);
      const credentials = claudeCredentialsFromOauth(oauth, {
        source: 'file',
        filePath: candidate.path,
        fileShape,
        identity: `path:${candidate.identityLabel}:${oauth?.subscriptionType || ''}:${oauth?.rateLimitTier || ''}`
      });
      if (credentials) return credentials;
    } catch (error) {
      if (error.code !== 'ENOENT') continue;
    }
  }

  if ((deps.platform || process.platform) === 'win32' && deps.readWindowsCredential !== false) {
    const text = await readWindowsClaudeCredentials(deps).catch(() => '');
    if (text) {
      try {
        const oauth = extractClaudeOauth(JSON.parse(text));
        const credentials = claudeCredentialsFromOauth(oauth, {
          source: 'wincred',
          identity: `wincred:Claude Code-credentials:${oauth?.subscriptionType || ''}:${oauth?.rateLimitTier || ''}`
        });
        if (credentials) return credentials;
      } catch (_) {}
    }
  }

  if ((deps.platform || process.platform) === 'darwin' && deps.readMacKeychain !== false) {
    const text = await readMacKeychainSecret('Claude Code-credentials', deps).catch(() => '');
    if (text) {
      const oauth = extractClaudeOauth(JSON.parse(text));
      const credentials = claudeCredentialsFromOauth(oauth, {
        source: 'keychain',
        identity: `keychain:Claude Code-credentials:${oauth?.subscriptionType || ''}:${oauth?.rateLimitTier || ''}`
      });
      if (credentials) return credentials;
    }
  }

  throw errorWithStatus('notConfigured', 'Claude credentials not found');
}

function windowsCredentialTargetCandidates(service, env = process.env) {
  const candidates = [service];
  for (const key of ['USER', 'USERNAME']) {
    const value = envValue(env, key);
    if (!value) continue;
    candidates.push(`${service}:${value}`, `${service}/${value}`);
  }
  return uniqueStrings(candidates);
}

async function readWindowsClaudeCredentials(deps = {}) {
  const service = 'Claude Code-credentials';
  const targets = windowsCredentialTargetCandidates(service, deps.env || process.env);
  if (deps.readWindowsCredentialSecret) return deps.readWindowsCredentialSecret(service, targets);
  return readWindowsCredentialSecret(service, targets, deps);
}

let winCredApi = null;

function loadWinCredApi(deps = {}) {
  if (deps.winCredApi) return deps.winCredApi;
  if (winCredApi !== null) return winCredApi;
  try {
    const koffi = deps.koffi || require('koffi');
    const advapi32 = koffi.load('advapi32.dll');
    const FILETIME = koffi.struct('FILETIME', {
      dwLowDateTime: 'uint32_t',
      dwHighDateTime: 'uint32_t'
    });
    const CREDENTIALW = koffi.struct('CREDENTIALW', {
      Flags: 'uint32_t',
      Type: 'uint32_t',
      TargetName: 'str16',
      Comment: 'str16',
      LastWritten: FILETIME,
      CredentialBlobSize: 'uint32_t',
      CredentialBlob: 'void *',
      Persist: 'uint32_t',
      AttributeCount: 'uint32_t',
      Attributes: 'void *',
      TargetAlias: 'str16',
      UserName: 'str16'
    });
    winCredApi = {
      koffi,
      CREDENTIALW,
      CredReadW: advapi32.func('bool CredReadW(const char16_t *TargetName, uint32_t Type, uint32_t Flags, _Out_ CREDENTIALW **Credential)'),
      CredFree: advapi32.func('void CredFree(void *Buffer)')
    };
  } catch (_) {
    winCredApi = false;
  }
  return winCredApi;
}

function decodeWindowsCredentialBlob(api, pointer, size) {
  if (!pointer || !size) return '';
  let buffer;
  try {
    buffer = Buffer.from(new Uint8Array(api.koffi.view(pointer, size)));
  } catch (_) {
    buffer = Buffer.from(api.koffi.decode(pointer, 'uint8_t', size));
  }
  const utf8 = buffer.toString('utf8').replace(/\0+$/g, '').trim();
  const utf16 = size % 2 === 0 ? buffer.toString('utf16le').replace(/\0+$/g, '').trim() : '';
  if (/^\s*[{[]/.test(utf8) || utf8.includes('accessToken')) return utf8;
  if (/^\s*[{[]/.test(utf16) || utf16.includes('accessToken')) return utf16;
  return utf8 || utf16;
}

function readWindowsCredentialSecret(_service, targets, deps = {}) {
  if ((deps.platform || process.platform) !== 'win32') return '';
  const api = loadWinCredApi(deps);
  if (!api) return '';
  const CRED_TYPE_GENERIC = 1;
  for (const target of targets) {
    const out = [null];
    try {
      if (!api.CredReadW(target, CRED_TYPE_GENERIC, 0, out) || !out[0]) continue;
      const credential = api.koffi.decode(out[0], api.CREDENTIALW);
      const text = decodeWindowsCredentialBlob(api, credential.CredentialBlob, credential.CredentialBlobSize);
      if (text) return text;
    } catch (_) {
      // Try the next target name; WinCred is a best-effort source.
    } finally {
      if (out[0]) {
        try { api.CredFree(out[0]); } catch (_) {}
      }
    }
  }
  return '';
}

function readMacKeychainSecret(service, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const signal = deps.signal;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const child = spawnFn('security', ['find-generic-password', '-s', service, '-w'], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch (_) {}
      finish(reject, abortError(signal));
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      finish(reject, new Error('macOS keychain lookup timed out'));
    }, 5000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code !== 0) finish(reject, new Error(stderr.trim() || `security exited ${code}`));
      else finish(resolve, stdout.trim());
    });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function runProcessText(command, args = [], options = {}) {
  const spawnFn = options.spawn || spawn;
  const timeoutMs = Number(options.timeoutMs || 30000);
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: Boolean(options.shell),
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const stopChild = () => {
      try { child.kill('SIGTERM'); } catch (_) {}
    };
    const onAbort = () => {
      stopChild();
      finish(reject, abortError(signal));
    };
    const timer = setTimeout(() => {
      stopChild();
      finish(reject, errorWithStatus('unavailable', `${command} timed out`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) finish(resolve, stdout);
      else finish(reject, errorWithStatus('unavailable', stderr.trim() || `${command} exited ${code}`));
    });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function fetchJson(url, headers, deps = {}, options = {}) {
  const fetchFn = deps.fetch || fetch;
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchFn(url, { headers, ...(controller ? { signal: controller.signal } : {}) });
    if (typeof options.onResponse === 'function') await options.onResponse(response);
    if (!response.ok) {
      const sourceChallenge = response.status === 403
        && String(response.headers?.get?.('cf-mitigated') || '').toLowerCase() === 'challenge';
      const status = response.status === 401
        || (options.forbiddenIsUnauthorized && response.status === 403 && !sourceChallenge)
        ? 'unauthorized'
        : response.status === 429
          ? 'sourceRateLimited'
          : 'unavailable';
      const error = errorWithStatus(status, `${url} returned ${response.status}`);
      // The normalized status collapses 404 and 5xx into `unavailable`, which
      // loses the only thing a caller needs to tell a permanent refusal from an
      // outage. Absent on timeouts and network errors, which are never either.
      error.httpStatus = response.status;
      if (sourceChallenge) error.code = 'CLAUDE_WEB_SOURCE_CHALLENGE';
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw errorWithStatus('unavailable', `${url} timed out`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fetchClaudeWebJson(url, headers, deps = {}, options = {}) {
  const viaChromium = typeof deps.claudeWebFetch === 'function';
  const webDeps = viaChromium ? { ...deps, fetch: deps.claudeWebFetch } : deps;
  // Chromium sends its own browser agent, and setting one here would override it
  // with a version that no longer matches the runtime. undici sends none at all,
  // and claude.ai's Cloudflare answers both that and an honest
  // `token-monitor/<version>` agent with `403 cf-mitigated: challenge`, so that
  // path has to present as a browser.
  const webHeaders = viaChromium ? headers : { ...headers, 'user-agent': BROWSER_USER_AGENT };
  return fetchJson(url, webHeaders, webDeps, {
    forbiddenIsUnauthorized: true,
    onResponse: options.onResponse
  });
}

function valueFromAliases(object, aliases) {
  if (!object || typeof object !== 'object') return undefined;
  for (const alias of aliases) {
    if (object[alias] !== undefined && object[alias] !== null) return object[alias];
  }
  return undefined;
}

function claudeUsageWindowUsedPercent(window) {
  const explicit = valueFromAliases(window, ['usedPercent', 'used_percent']);
  if (explicit !== undefined) return explicit;
  const utilization = valueFromAliases(window, ['utilization', 'percent']);
  return utilization;
}

// Temporary: the "Fable only" weekly cap is a limited-time promo (through ~2026-07-07)
// that only appears in the structured `limits[]` array as a `weekly_scoped` entry —
// never as a named top-level field like `seven_day`. Surface just that one scoped
// window; once the promo ends it drops out of `limits[]` and this returns null, so
// the bar self-removes. Safe to delete this helper (and its call site) afterwards.
function claudeFableWeeklyWindow(usage) {
  const limits = Array.isArray(usage?.limits) ? usage.limits : [];
  for (const entry of limits) {
    if (!entry || entry.kind !== 'weekly_scoped') continue;
    const displayName = String(entry.scope?.model?.display_name || '').trim();
    if (!/^fable$/i.test(displayName)) continue;
    return {
      kind: 'weekly',
      label: displayName,
      usedPercent: claudeUsageWindowUsedPercent(entry),
      resetsAt: valueFromAliases(entry, ['resets_at', 'resetsAt'])
    };
  }
  return null;
}

// `spend` amounts are self-describing: `{amount_minor, currency, exponent}`.
function claudeSpendMoney(value) {
  if (!value || typeof value !== 'object') return null;
  const minor = Number(valueFromAliases(value, ['amount_minor', 'amountMinor']));
  if (!Number.isFinite(minor)) return null;
  const exponent = Number(valueFromAliases(value, ['exponent']));
  const scale = Number.isFinite(exponent) ? 10 ** exponent : 100;
  return {
    amount: minor / scale,
    currency: String(valueFromAliases(value, ['currency']) || '').trim().toUpperCase() || null
  };
}

// `extra_usage` carries bare minor-unit numbers plus one shared `decimal_places`.
function claudeExtraUsageMoney(extra, key) {
  const raw = Number(valueFromAliases(extra || {}, [key]));
  if (!Number.isFinite(raw)) return null;
  const places = Number(valueFromAliases(extra || {}, ['decimal_places', 'decimalPlaces']));
  return raw / 10 ** (Number.isFinite(places) && places >= 0 ? places : 2);
}

// Gate on the enable flags, never on "is there a value": a credits-off account
// reports used 0, and so does one enabled a minute ago. Also gates the prepaid
// balance request, which is why it is a named helper.
function claudeUsageCreditsEnabled(usage) {
  const spend = valueFromAliases(usage, ['spend']) || null;
  const extra = valueFromAliases(usage, ['extra_usage', 'extraUsage']) || null;
  return spend?.enabled === true
    || valueFromAliases(extra || {}, ['is_enabled', 'isEnabled']) === true;
}

// Usage credits: `spend` and `extra_usage` are the same money in two spellings
// (both report 235/2000 on a live account), so this yields one window. `spend`
// wins because its units are self-describing.
function claudeUsageCreditsWindow(usage) {
  if (!claudeUsageCreditsEnabled(usage)) return null;
  const spend = valueFromAliases(usage, ['spend']) || null;
  const extra = valueFromAliases(usage, ['extra_usage', 'extraUsage']) || null;

  const spendUsed = claudeSpendMoney(spend?.used);
  const spendLimit = claudeSpendMoney(spend?.limit);
  const used = spendUsed ? spendUsed.amount : claudeExtraUsageMoney(extra, 'used_credits');
  if (used === null) return null;
  const limit = spendLimit ? spendLimit.amount : claudeExtraUsageMoney(extra, 'monthly_limit');
  const currency = (spendUsed && spendUsed.currency)
    || String(valueFromAliases(extra || {}, ['currency']) || 'USD').trim().toUpperCase();

  return {
    kind: 'billing',
    // `spend` is the machine-readable role: a `billing` window alone cannot be
    // told apart from the Balance window, and renderers must not key off a
    // display label. Headline is money already consumed, not money remaining.
    metric: 'spend',
    label: 'Usage credits',
    used,
    // A null limit means "no monthly cap". No percentage is passed in either
    // case: `percentFromWindow` derives it from used/limit when a limit exists,
    // and `spend.percent` must never be forwarded — it reports 0, not null,
    // when unlimited, which would paint a 0% meter over real spending.
    limit,
    currency,
    showMeter: limit !== null
  };
}

function mapClaudeUsageToProvider(usage, meta = {}) {
  const windows = [];
  const session = valueFromAliases(usage, ['five_hour', 'fiveHour']);
  const weekly = valueFromAliases(usage, ['seven_day', 'sevenDay']);
  if (session) {
    windows.push({
      kind: 'session',
      usedPercent: claudeUsageWindowUsedPercent(session),
      resetsAt: valueFromAliases(session, ['resets_at', 'resetsAt'])
    });
  }
  if (weekly) {
    windows.push({
      kind: 'weekly',
      usedPercent: claudeUsageWindowUsedPercent(weekly),
      resetsAt: valueFromAliases(weekly, ['resets_at', 'resetsAt'])
    });
  }
  const fableWeekly = claudeFableWeeklyWindow(usage);
  if (fableWeekly) windows.push(fableWeekly);
  const usageCredits = claudeUsageCreditsWindow(usage);
  if (usageCredits) windows.push(usageCredits);
  return normalizeLimitProvider({
    provider: 'claude',
    accountKey: meta.accountKey || '',
    accountLabel: meta.accountLabel || '',
    accountName: meta.accountName || '',
    accountEmail: meta.accountEmail || '',
    source: meta.source || 'oauth',
    status: 'ok',
    updatedAt: meta.updatedAt,
    windows
  });
}

async function refreshClaudeAccessToken(refreshToken, deps = {}) {
  if (!refreshToken) throw errorWithStatus('unauthorized', 'No refresh token available');
  const fetchFn = deps.fetch || fetch;
  const url = deps.claudeTokenUrl || CLAUDE_OAUTH_TOKEN_URL;
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID
  });
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': TOKEN_MONITOR_USER_AGENT
      },
      body: body.toString(),
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) {
      const status = response.status === 400 || response.status === 401 ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw errorWithStatus(status, `oauth/token returned ${response.status}`);
    }
    const json = await response.json();
    const nowMs = (deps.now || Date.now)();
    const lifetimeSec = Math.max(60, Number(json.expires_in) || 3600);
    return {
      accessToken: String(json.access_token),
      refreshToken: json.refresh_token ? String(json.refresh_token) : refreshToken,
      expiresAt: nowMs + lifetimeSec * 1000
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw errorWithStatus('unavailable', 'oauth/token timed out');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeClaudeCredentials(filePath, fileShape, updated, deps = {}) {
  const readFile = deps.readFile || fs.promises.readFile;
  const writeFile = deps.writeFile || fs.promises.writeFile;
  const rename = deps.rename || fs.promises.rename;
  let existing;
  try {
    existing = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (_) { return false; }
  if (!existing || typeof existing !== 'object') return false;
  if (fileShape === 'claudeAiOauth') {
    existing.claudeAiOauth = { ...(existing.claudeAiOauth || {}), ...updated };
  } else {
    Object.assign(existing, updated);
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpPath, filePath);
    return true;
  } catch (_) {
    try { await (deps.unlink || fs.promises.unlink)(tmpPath); } catch (__) {}
    return false;
  }
}

async function persistClaudeRefresh(credentials, refreshed, deps = {}) {
  if (credentials.source !== 'file' || !credentials.filePath) return;
  await writeClaudeCredentials(credentials.filePath, credentials.fileShape, refreshed, deps).catch(() => {});
}

function callClaudeUsage(accessToken, deps = {}) {
  return fetchJson(CLAUDE_USAGE_URL, {
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'user-agent': TOKEN_MONITOR_USER_AGENT
  }, deps);
}

function callClaudeProfile(accessToken, deps = {}) {
  return fetchJson(CLAUDE_PROFILE_URL, {
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
    'user-agent': TOKEN_MONITOR_USER_AGENT
  }, deps);
}

function claudeWebOrganizations(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.organizations)) return body.organizations;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

function claudeWebOrganizationId(organization) {
  return String(organization?.uuid || organization?.id || organization?.organization_uuid || '').trim();
}

function claudeWebOrganizationCapabilities(organization) {
  if (!Array.isArray(organization?.capabilities)) return new Set();
  return new Set(
    organization.capabilities
      .map((capability) => String(capability || '').trim().toLowerCase())
      .filter(Boolean)
  );
}

// On a personal claude.ai account the plan is not on the membership at all:
// `seat_tier` is null and neither `rate_limit_tier` nor `billing_type` exists
// at that level. The organization's capability list carries it, and it is the
// same list that already decides which organization to read. Returns the shared
// alias key rather than a display string, so a plan read here renders
// identically to the same plan read from OAuth credentials.
//
// `raven` covers Team and Enterprise together; `raven_type` separates them, and
// claude.ai treats a raven organization without one as unknown rather than as
// Team. This mirrors that: a capability that cannot name the plan yields
// nothing and lets the seat tier answer instead.
function claudeCapabilityPlan(capabilities, organization) {
  if (capabilities.has('claude_max')) return 'max';
  if (capabilities.has('claude_pro')) return 'pro';
  if (!capabilities.has('raven')) return '';
  const ravenType = String(organization?.raven_type || '').trim().toLowerCase();
  if (!ravenType) return '';
  return ravenType === 'enterprise' ? 'enterprise' : 'team';
}

// A seat tier is `<plan>_<seat level>` (`enterprise_standard`), and only the
// plan half belongs in a plan label: keeping the level renders "Enterprise
// Standard" where the same account over OAuth renders "Enterprise".
//
// A value with no recognized plan in front contributes nothing. A bare seat
// level says which seat someone holds, not which plan they are on, so rendering
// it puts membership bookkeeping where the plan goes: `standard` would read as
// a plan called Standard, and `unassigned` (what claude.ai substitutes for a
// member holding no seat) as one called Unassigned.
function claudeSeatTier(membership) {
  const [plan] = cleanPlanText(membership?.seat_tier).split(' ');
  return PLAN_LABEL_ALIASES[plan] ? plan : '';
}

function selectClaudeWebOrganization(organizations) {
  const candidates = organizations.filter((candidate) => claudeWebOrganizationId(candidate));
  const hasChatCapability = (candidate) => (
    claudeWebOrganizationCapabilities(candidate).has('chat')
  );
  const isApiOnly = (candidate) => {
    const capabilities = claudeWebOrganizationCapabilities(candidate);
    return capabilities.size === 1 && capabilities.has('api');
  };
  return candidates.find(hasChatCapability)
    || candidates.find((candidate) => !isApiOnly(candidate))
    || candidates[0]
    || null;
}

// Exact matches only. Everything read off a membership is scoped to its own
// organization, so falling back to "whichever membership came first" labels the
// organization we resolved usage for with a different one's plan and name. On a
// multi-organization account that is not a near miss, it is the wrong answer.
// The selected organization carries the same fields and is always available.
function claudeWebMembership(accountBody, organizationId) {
  if (!organizationId) return null;
  const account = accountBody?.account && typeof accountBody.account === 'object'
    ? accountBody.account
    : accountBody;
  const memberships = Array.isArray(account?.memberships)
    ? account.memberships
    : Array.isArray(accountBody?.memberships)
      ? accountBody.memberships
      : [];
  return memberships.find((membership) => (
    claudeWebOrganizationId(membership?.organization || membership) === organizationId
  )) || null;
}

function claudeStableIdentity(accountId, organizationId, accountEmail) {
  if (accountId) return `account:${accountId}`;
  if (organizationId) return `organization:${organizationId}`;
  return accountEmail;
}

function claudeWebAccountIdentity(accountBody, organization) {
  const organizationId = claudeWebOrganizationId(organization);
  const membership = claudeWebMembership(accountBody, organizationId);
  const account = accountBody?.account && typeof accountBody.account === 'object'
    ? accountBody.account
    : accountBody || {};
  const memberOrganization = membership?.organization && typeof membership.organization === 'object'
    ? membership.organization
    : {};
  const accountId = String(account.uuid || account.id || account.account_uuid || '').trim();
  const accountEmail = String(
    account.email_address || account.email || accountBody?.email_address || accountBody?.email || ''
  ).trim().toLowerCase();
  const accountName = String(
    memberOrganization.name
      || memberOrganization.display_name
      || organization?.name
      || organization?.display_name
      || account.name
      || account.display_name
      || ''
  ).trim();
  const stableIdentity = claudeStableIdentity(accountId, organizationId, accountEmail);
  if (!stableIdentity) {
    throw claudeIdentityUnavailable('Claude Web account did not include a stable account identity');
  }
  // The organization we resolved usage for, falling back to the membership's
  // own copy only when no organization was passed in at all.
  const planOrganization = organization && typeof organization === 'object'
    ? organization
    : memberOrganization;
  // The organization states the plan; a seat tier only implies one, so it
  // answers second. `billing_type` is deliberately not consulted at all: it is
  // a payment method (`apple_subscription`), never a plan, so reading it would
  // label a Pro account "Apple subscription".
  const accountLabel = claudePlanLabelFromParts(
    claudeCapabilityPlan(claudeWebOrganizationCapabilities(planOrganization), planOrganization)
      || claudeSeatTier(membership)
      || account?.subscription_type,
    membership?.rate_limit_tier || planOrganization?.rate_limit_tier || account?.rate_limit_tier
  );
  return {
    accountKey: hashKey('claude-account', stableIdentity),
    accountEmail,
    accountName,
    accountLabel
  };
}

function claudeIdentityCache(deps = {}) {
  if (!(deps.providerRuntimeState instanceof Map)) return null;
  let cache = deps.providerRuntimeState.get(CLAUDE_IDENTITY_CACHE_STATE_KEY);
  if (!(cache instanceof Map)) {
    cache = new Map();
    deps.providerRuntimeState.set(CLAUDE_IDENTITY_CACHE_STATE_KEY, cache);
  }
  return cache;
}

function claudeIdentityCacheTtlMs(deps = {}) {
  const configured = Number(deps.claudeIdentityCacheTtlMs);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : CLAUDE_IDENTITY_CACHE_TTL_MS;
}

function claudeCachedIdentity(fingerprint, deps = {}, options = {}) {
  const cache = claudeIdentityCache(deps);
  if (!cache || !fingerprint) return null;
  const entry = cache.get(fingerprint);
  if (!entry) return null;
  cache.delete(fingerprint);
  cache.set(fingerprint, entry);
  if (options.allowStale) return entry;
  const nowMs = (deps.now || Date.now)();
  return nowMs - entry.resolvedAt <= claudeIdentityCacheTtlMs(deps) ? entry : null;
}

function cacheClaudeIdentity(fingerprint, entry, deps = {}) {
  const cache = claudeIdentityCache(deps);
  if (!cache || !fingerprint || !entry?.identity?.accountKey) return entry;
  const previous = cache.get(fingerprint);
  const resolved = {
    ...entry,
    identity: {
      ...entry.identity,
      ...(previous?.identity?.accountKey ? { accountKey: previous.identity.accountKey } : {})
    },
    resolvedAt: (deps.now || Date.now)()
  };
  cache.delete(fingerprint);
  cache.set(fingerprint, resolved);
  while (cache.size > CLAUDE_IDENTITY_CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  return resolved;
}

function claudeWebIdentityFingerprint(cookie) {
  return cookie ? hashKey('claude-web-identity-cache', cookie) : '';
}

function claudeWebSessionKey(cookie) {
  return String(cookie || '').replace(/^sessionKey=/, '');
}

function claudeWebSetCookieValues(response) {
  const headers = response?.headers;
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    const values = headers.getSetCookie();
    if (Array.isArray(values)) return values;
  }
  const value = typeof headers.get === 'function' ? headers.get('set-cookie') : '';
  return value ? [value] : [];
}

function claudeWebRenewedSessionKey(response) {
  if (!response?.ok) return '';
  let latest = '';
  for (const header of claudeWebSetCookieValues(response)) {
    const pattern = /(?:^|[,\r\n])\s*sessionKey=([^;,\r\n]+)/ig;
    for (const match of String(header || '').matchAll(pattern)) {
      const value = String(match[1] || '').trim();
      if (value.startsWith('sk-ant-')) latest = value;
    }
  }
  return latest;
}

function createClaudeWebSession(cookie) {
  const initialCookie = normalizeClaudeWebCookieInput(cookie);
  let sessionKey = claudeWebSessionKey(initialCookie);
  return {
    headers() {
      return {
        accept: 'application/json',
        cookie: `sessionKey=${sessionKey}`
      };
    },
    observe(response) {
      sessionKey = claudeWebRenewedSessionKey(response) || sessionKey;
    },
    cookie() {
      return `sessionKey=${sessionKey}`;
    },
    initialCookie
  };
}

function claudeOauthIdentityFingerprint(credentials) {
  const secret = credentials?.refreshToken || credentials?.accessToken;
  return secret
    ? hashKey('claude-oauth-identity-cache', credentials?.source || '', secret)
    : '';
}

function carryClaudeCachedIdentity(previousCredentials, nextCredentials, deps = {}) {
  const previousFingerprint = claudeOauthIdentityFingerprint(previousCredentials);
  const nextFingerprint = claudeOauthIdentityFingerprint(nextCredentials);
  if (!previousFingerprint || !nextFingerprint || previousFingerprint === nextFingerprint) return;
  const cached = claudeCachedIdentity(previousFingerprint, deps, { allowStale: true });
  if (cached) cacheClaudeIdentity(nextFingerprint, cached, deps);
}

// claude.ai's prepaid credit pool. Web-session only: the same path under an
// OAuth bearer returns 403 account_session_invalid, and api.anthropic.com has no
// equivalent, so this never runs on the OAuth path.
function claudeTrancheAmount(entry) {
  const minor = Number(
    entry?.remaining_amount_minor_units
    ?? entry?.remainingAmountMinorUnits
    ?? entry?.amount_minor
  );
  return Number.isFinite(minor) ? minor / 100 : null;
}

function claudePrepaidBalance(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const minor = Number(payload.amount);
  // A genuine 0 is kept, matching the documented balance contract: an account
  // that has spent its pool dry still needs the row — that is precisely when it
  // matters most. Callers gate on whether usage credits are enabled at all.
  if (!Number.isFinite(minor) || minor < 0) return null;
  const currency = String(payload.currency || 'USD').trim().toUpperCase();
  // Purchased and granted credits share one pool in the UI; merge them and let
  // normalization sort by expiry.
  const entries = [
    ...(Array.isArray(payload.tranches) ? payload.tranches : []),
    ...(Array.isArray(payload.promo_tranches) ? payload.promo_tranches : [])
  ];
  const tranches = [];
  for (const entry of entries) {
    const amount = claudeTrancheAmount(entry);
    if (amount === null) continue;
    tranches.push({
      amount,
      currency: String(entry.currency || currency).trim().toUpperCase(),
      expiresAt: entry.expires_at ?? entry.expiresAt ?? null
    });
  }
  return {
    amount: minor / 100,
    currency,
    expiresAt: payload.next_expires_at ?? payload.nextExpiresAt ?? null,
    tranches
  };
}

// "Has this account ever put money in the pool?" An account that never bought
// credits and one that bought some look identical apart from this.
function claudePrepaidFunded(balance) {
  if (!balance) return false;
  if (Number(balance.amount) > 0) return true;
  return Array.isArray(balance.tranches) && balance.tranches.length > 0;
}

function claudePrepaidCache(deps = {}) {
  if (!(deps.providerRuntimeState instanceof Map)) return null;
  let cache = deps.providerRuntimeState.get(CLAUDE_PREPAID_CACHE_STATE_KEY);
  if (!(cache instanceof Map)) {
    cache = new Map();
    deps.providerRuntimeState.set(CLAUDE_PREPAID_CACHE_STATE_KEY, cache);
  }
  return cache;
}

// Derived from the limits refresh interval rather than exposed as its own knob:
// nobody can reason about "should my balance refresh every 10 or 15 minutes",
// and two competing cadence settings in one panel is worse than one. Doubling
// the interval keeps the balance off every other refresh at any interval.
function claudePrepaidBaseTtlMs(deps, options) {
  const configured = Number(deps.claudePrepaidCacheTtlMs);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  const refreshMs = Number(options.limitsRefreshMs ?? options.refreshMs ?? deps.limitsRefreshMs);
  return Number.isFinite(refreshMs) && refreshMs > 0
    ? refreshMs * 2
    : CLAUDE_PREPAID_CACHE_TTL_MS;
}

// `idle` is an unfunded pool on an account that is not spending credits either
// — the shape of everyone who never bought any. Nothing is displayed for them
// and nothing changes until they buy, so they back off to a request an hour.
// It is evaluated per read rather than frozen into the entry: enabling usage
// credits must bring the balance back at the normal cadence.
function claudePrepaidCacheTtlMs(deps = {}, options = {}, idle = false) {
  const base = claudePrepaidBaseTtlMs(deps, options);
  return idle ? base * CLAUDE_PREPAID_IDLE_TTL_FACTOR : base;
}

// Returns the cached balance when it is still fresh. A cached `null` counts:
// re-probing an account that has no prepaid credits every refresh would be the
// same wasted request, just for the majority of users.
function claudeCachedPrepaid(key, deps = {}, options = {}, creditsEnabled = false) {
  const cache = claudePrepaidCache(deps);
  if (!cache || !key) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  const nowMs = (deps.now || Date.now)();
  const ttlMs = claudePrepaidCacheTtlMs(deps, options, !creditsEnabled && !entry.funded);
  return nowMs - entry.resolvedAt <= ttlMs ? entry : null;
}

// The prepaid cache is keyed on the resolved account and the organization whose
// pool it is, never on the cookie digest the identity cache uses. A sessionKey
// rotates mid-session, and a credential-keyed entry is stranded the moment it
// does: the next refresh re-reads the pool, and a read that fails then has no
// last-good balance left to fall back on. Both parts are already hashed or
// public identifiers — the pool belongs to the organization, and the account
// decides whether it may be read at all.
function claudePrepaidKey(context) {
  const accountKey = context?.identity?.accountKey;
  if (!accountKey) return '';
  return `${accountKey}|${context?.organizationId || ''}`;
}

// The last balance read for this account, however old. Serving it through an
// outage keeps a real balance on screen instead of blanking the row until the
// endpoint recovers; the pool moves slowly enough that a stale figure beats no
// figure, and the next successful read corrects it.
function staleClaudePrepaid(key, deps = {}) {
  const cache = claudePrepaidCache(deps);
  if (!cache || !key) return null;
  return cache.get(key)?.balance ?? null;
}

// A refusal this account will get again: reading the pool is not permitted, or
// there is nothing at that path. A 403 carrying a Cloudflare challenge is not
// one — that is an interstitial, and it clears.
function claudePrepaidRefused(error) {
  if (error?.code === 'CLAUDE_WEB_SOURCE_CHALLENGE') return false;
  return error?.httpStatus === 403 || error?.httpStatus === 404;
}

function cacheClaudePrepaid(key, balance, deps = {}) {
  const cache = claudePrepaidCache(deps);
  if (!cache || !key) return balance;
  cache.delete(key);
  cache.set(key, {
    balance,
    funded: claudePrepaidFunded(balance),
    resolvedAt: (deps.now || Date.now)()
  });
  while (cache.size > CLAUDE_IDENTITY_CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  return balance;
}

async function fetchClaudeWebLimits(cookie, deps = {}, options = {}) {
  const nowMs = (deps.now || Date.now)();
  const baseUrl = String(deps.claudeWebBaseUrl || CLAUDE_WEB_BASE_URL).replace(/\/$/, '');
  const session = createClaudeWebSession(cookie);
  let reportedCookie = session.initialCookie;
  const observeResponse = async (response) => {
    session.observe(response);
    const renewedCookie = session.cookie();
    if (renewedCookie === reportedCookie) return;
    const previousCookie = reportedCookie;
    try {
      const persisted = await deps.onClaudeWebCookieRenewed?.({
        previousCookie,
        cookie: renewedCookie
      });
      if (persisted !== false) reportedCookie = renewedCookie;
    } catch (error) {
      deps.logger?.(`[limits] Claude Web session renewal could not be persisted: ${error.message}`);
    }
  };
  const fetchWebJson = (url) => fetchClaudeWebJson(url, session.headers(), deps, {
    onResponse: observeResponse
  });
  const fingerprint = claudeWebIdentityFingerprint(cookie);
  let context = claudeCachedIdentity(fingerprint, deps);
  let usage;
  if (!context) {
    const stale = claudeCachedIdentity(fingerprint, deps, { allowStale: true });
    const organizationsBody = await fetchWebJson(`${baseUrl}/api/organizations`);
    const organizations = claudeWebOrganizations(organizationsBody);
    const organization = selectClaudeWebOrganization(organizations);
    const organizationId = claudeWebOrganizationId(organization);
    if (!organizationId) throw errorWithStatus('unavailable', 'Claude Web organization not found');
    usage = await fetchWebJson(
      `${baseUrl}/api/organizations/${encodeURIComponent(organizationId)}/usage`
    );
    try {
      const accountBody = await fetchWebJson(`${baseUrl}/api/account`);
      context = cacheClaudeIdentity(fingerprint, {
        organizationId,
        identity: claudeWebAccountIdentity(accountBody, organization)
      }, deps);
    } catch (error) {
      if (!stale) {
        throw claudeIdentityUnavailable('Claude Web usage is available, but stable account identity could not be resolved', error);
      }
      context = {
        organizationId,
        identity: stale.identity,
        resolvedAt: stale.resolvedAt
      };
    }
  } else {
    usage = await fetchWebJson(
      `${baseUrl}/api/organizations/${encodeURIComponent(context.organizationId)}/usage`
    );
  }
  const renewedCookie = session.cookie();
  if (renewedCookie !== session.initialCookie) {
    const renewedFingerprint = claudeWebIdentityFingerprint(renewedCookie);
    if (renewedFingerprint !== fingerprint) cacheClaudeIdentity(renewedFingerprint, context, deps);
  }
  // The pool is read whenever the setting allows it, deliberately not only when
  // the account has usage credits switched on: switching them off is what you
  // do to stop a balance you still hold from being spent, and the money and its
  // expiry dates are exactly what you want to see while it is off.
  const wantsPrepaid = claudePrepaidBalanceEnabled(deps.env || process.env, options);
  const creditsEnabled = claudeUsageCreditsEnabled(usage);
  const prepaidKey = claudePrepaidKey(context);
  // Best-effort and throttled: a 403/404/timeout here must not cost the account
  // its usage row, and the pool moves too slowly to re-read every refresh.
  const cachedPrepaid = wantsPrepaid
    ? claudeCachedPrepaid(prepaidKey, deps, options, creditsEnabled)
    : null;
  let balance = cachedPrepaid ? cachedPrepaid.balance : null;
  if (wantsPrepaid && !cachedPrepaid) {
    try {
      const prepaid = await fetchWebJson(
        `${baseUrl}/api/organizations/${encodeURIComponent(context.organizationId)}/prepaid/credits`
      );
      balance = cacheClaudePrepaid(prepaidKey, claudePrepaidBalance(prepaid), deps);
    } catch (error) {
      deps.logger?.(`[limits] Claude prepaid credits unavailable: ${error.message}`);
      if (claudePrepaidRefused(error)) {
        // Cache the refusal. An endpoint that refuses this account refuses it
        // every refresh, and without an entry there is nothing to back off from.
        cacheClaudePrepaid(prepaidKey, null, deps);
      } else {
        // A timeout, a 429 or a 5xx says nothing about this account. Caching it
        // as "no balance" would blank a balance that is still there — and on a
        // credits-off account the idle backoff would hold that blank for an
        // hour. Keep the last figure and let the next refresh retry.
        balance = staleClaudePrepaid(prepaidKey, deps);
      }
    }
  }
  // A pool nobody ever funded is not a balance. Reporting it would put a $0.00
  // row on every Web account that has never touched credits. With usage credits
  // on, a pool spent dry is precisely when the row matters, so zero is kept.
  if (balance && !creditsEnabled && !claudePrepaidFunded(balance)) balance = null;
  const provider = mapClaudeUsageToProvider(usage, {
    ...context.identity,
    updatedAt: nowIso(nowMs),
    source: 'web'
  });
  if (!balance) return provider;
  return normalizeLimitProvider({
    ...provider,
    balance,
    // Emit the credits window ourselves. normalizeLimitProvider synthesizes a
    // metered one whenever a balance has no credits window, and that meter
    // derives amount/(amount+monthSpend) — a denominator this pool doesn't have.
    windows: [
      ...provider.windows,
      {
        kind: 'billing',
        metric: 'credits',
        label: 'Balance',
        remaining: balance.amount,
        currency: balance.currency,
        showMeter: false
      }
    ]
  });
}

function claudeIdentityUnavailable(message, cause) {
  const error = errorWithStatus('unavailable', message);
  error.code = 'CLAUDE_IDENTITY_UNAVAILABLE';
  if (cause) error.cause = cause;
  return error;
}

function claudeOauthAccountIdentity(profile) {
  const account = profile?.account && typeof profile.account === 'object' ? profile.account : {};
  const organization = profile?.organization && typeof profile.organization === 'object'
    ? profile.organization
    : {};
  const accountId = String(account.uuid || account.id || profile?.account_uuid || '').trim();
  const organizationId = String(
    organization.uuid || organization.id || profile?.organization_uuid || ''
  ).trim();
  const accountEmail = String(
    account.email || account.email_address || profile?.email || profile?.email_address || ''
  ).trim().toLowerCase();
  const accountName = String(
    account.display_name
      || account.full_name
      || account.name
      || organization.display_name
      || organization.name
      || ''
  ).trim();
  const stableIdentity = claudeStableIdentity(accountId, organizationId, accountEmail);
  if (!stableIdentity) {
    throw claudeIdentityUnavailable('Claude profile did not include a stable account identity');
  }

  return {
    accountKey: hashKey('claude-account', stableIdentity),
    accountEmail,
    accountName
  };
}

async function resolveClaudeOauthIdentity(credentials, deps = {}) {
  const fingerprint = claudeOauthIdentityFingerprint(credentials);
  const fresh = claudeCachedIdentity(fingerprint, deps);
  if (fresh) return fresh.identity;
  const stale = claudeCachedIdentity(fingerprint, deps, { allowStale: true });
  try {
    const identity = claudeOauthAccountIdentity(
      await callClaudeProfile(credentials.accessToken, deps)
    );
    return cacheClaudeIdentity(fingerprint, { identity }, deps).identity;
  } catch (error) {
    if (stale) return stale.identity;
    if (error?.code === 'CLAUDE_IDENTITY_UNAVAILABLE') throw error;
    throw claudeIdentityUnavailable('Claude profile lookup failed', error);
  }
}

async function delegatedClaudeRefresh(currentCredentials, deps = {}) {
  // Spawn `claude /status` in a PTY and let Claude Code itself refresh the token.
  // Matches CodexBar's strategy — Claude Code is a native Anthropic application,
  // so OAuth credential use stays within sanctioned channels. Best-effort: if the
  // probe fails we still re-read in case Claude Code touched the credentials.
  await touchClaudeAuthPath(deps).catch(() => null);
  const fresh = await readClaudeCredentials(deps);
  if (!fresh.accessToken || fresh.accessToken === currentCredentials.accessToken) {
    throw errorWithStatus('unauthorized', 'Claude Code did not refresh the OAuth token');
  }
  return fresh;
}

async function refreshClaudeCredentials(currentCredentials, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'darwin') return delegatedClaudeRefresh(currentCredentials, deps);
  if (!currentCredentials.refreshToken) {
    throw errorWithStatus('unauthorized', 'No refresh token available');
  }
  const refreshed = await refreshClaudeAccessToken(currentCredentials.refreshToken, deps);
  await persistClaudeRefresh(currentCredentials, refreshed, deps);
  return { ...currentCredentials, ...refreshed };
}

async function fetchClaudeLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const platform = deps.platform || process.platform;
  const webCookie = claudeWebCookie(deps.env || process.env, options);
  if (webCookie) return fetchClaudeWebLimits(webCookie, deps, options);
  let oauthIdentity = null;
  try {
    let credentials = await readClaudeCredentials(deps);
    oauthIdentity = claudeCachedIdentity(
      claudeOauthIdentityFingerprint(credentials),
      deps,
      { allowStale: true }
    )?.identity || null;

    // Proactive refresh only on non-darwin: mac uses delegated (spawning Claude Code)
    // which is expensive; CodexBar's design likewise refreshes reactively, not on expiry.
    if (platform !== 'darwin' && credentials.refreshToken && credentials.expiresAt
      && credentials.expiresAt - nowMs < CLAUDE_REFRESH_LEEWAY_MS) {
      try {
        const previousCredentials = credentials;
        credentials = await refreshClaudeCredentials(credentials, deps);
        carryClaudeCachedIdentity(previousCredentials, credentials, deps);
      } catch (_) { /* fall through; reactive retry below may still succeed */ }
    }

    let usage;
    try {
      usage = await callClaudeUsage(credentials.accessToken, deps);
    } catch (error) {
      if (error?.status !== 'unauthorized') throw error;
      const previousCredentials = credentials;
      credentials = await refreshClaudeCredentials(credentials, deps);
      carryClaudeCachedIdentity(previousCredentials, credentials, deps);
      usage = await callClaudeUsage(credentials.accessToken, deps);
    }

    try {
      oauthIdentity = await resolveClaudeOauthIdentity(credentials, deps);
    } catch (error) {
      if (error?.cause?.status !== 'unauthorized') throw error;
      const previousCredentials = credentials;
      credentials = await refreshClaudeCredentials(credentials, deps);
      carryClaudeCachedIdentity(previousCredentials, credentials, deps);
      oauthIdentity = await resolveClaudeOauthIdentity(credentials, deps);
    }
    const provider = mapClaudeUsageToProvider(usage, {
      ...oauthIdentity,
      accountLabel: credentials.accountLabel,
      updatedAt: nowIso(nowMs),
      source: 'oauth'
    });
    return provider;
  } catch (error) {
    // A successful quota response without a stable account identity must not
    // create a new row keyed by credential storage location or a different
    // fallback source. Let LimitsRuntime retain the previous account row.
    if (error?.code === 'CLAUDE_IDENTITY_UNAVAILABLE') throw error;
    if (!shouldTryClaudeCliFallback(error)) throw error;
    try {
      const text = await runClaudeUsageCli(deps);
      const provider = mapClaudeCliUsageToProvider(text, {
        updatedAt: nowIso(nowMs),
        now: new Date(nowMs)
      });
      if (!oauthIdentity) return provider;
      return {
        ...provider,
        accountKey: oauthIdentity.accountKey,
        accountEmail: oauthIdentity.accountEmail,
        accountName: oauthIdentity.accountName
      };
    } catch (_) {
      throw error;
    }
  }
}

function stripAnsiCodes(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[78=>][^\x1b]*/g, '');
}

function normalizeForLabelSearch(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9%]+/g, '');
}

function linePercentLeft(line) {
  const match = String(line || '').match(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i);
  if (!match) return null;
  const number = Math.max(0, Math.min(100, Number(match[1])));
  const lower = String(line || '').toLowerCase();
  if (lower.includes('used') || lower.includes('spent') || lower.includes('consumed')) return 100 - number;
  if (lower.includes('left') || lower.includes('remaining') || lower.includes('available')) return number;
  return null;
}

function extractClaudePercent(lines, label) {
  const normalizedLabel = normalizeForLabelSearch(label);
  const normalizedLines = lines.map(normalizeForLabelSearch);
  for (let i = 0; i < normalizedLines.length; i += 1) {
    if (!normalizedLines[i].includes(normalizedLabel)) continue;
    for (const line of lines.slice(i, i + 12)) {
      const percentLeft = linePercentLeft(line);
      if (percentLeft !== null && Number.isFinite(percentLeft)) return Math.round(percentLeft);
    }
  }
  return null;
}

function cleanClaudeResetLine(line) {
  const match = String(line || '').match(/resets[^\r\n]*/i);
  if (!match) return '';
  return match[0]
    .replace(/\([^)]*\)?/g, '')
    .replace(/^(resets?)(?=\d|[a-z])/i, '$1 ')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)(\d{1,2})/ig, '$1 $2')
    .replace(/(\d{1,2})(at)(\d{1,2})/ig, '$1 $2 $3')
    .replace(/([a-z])(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/ig, '$1 $2$3$4')
    .replace(/[)\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractClaudeReset(lines, label) {
  const normalizedLabel = normalizeForLabelSearch(label);
  const normalizedLines = lines.map(normalizeForLabelSearch);
  for (let i = 0; i < normalizedLines.length; i += 1) {
    if (!normalizedLines[i].includes(normalizedLabel)) continue;
    for (const line of lines.slice(i, i + 14)) {
      const normalized = normalizeForLabelSearch(line);
      if (normalized.startsWith('current') && !normalized.includes(normalizedLabel)) break;
      const reset = cleanClaudeResetLine(line);
      if (reset) return reset;
    }
  }
  return '';
}

function allClaudeResetLines(lines) {
  return uniqueStrings(lines.map(cleanClaudeResetLine).filter(Boolean));
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11
};

function parseClock(hourText, minuteText, meridiem) {
  let hour = Number(hourText);
  const minute = minuteText === undefined || minuteText === '' ? 0 : Number(minuteText);
  const suffix = String(meridiem || '').toLowerCase();
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function claudeResetShape(text) {
  let raw = String(text || '').trim();
  raw = raw.replace(/^resets?:?\s*/i, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\bat\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^\d{1,2}(?::\d{2})?\s*(am|pm)$/i.test(raw)) return 'time';
  if (/^[a-z]{3,4}\s+\d{1,2}(?:,?\s+\d{1,2}(?::\d{2})?\s*(am|pm)?)?$/i.test(raw)) return 'date';
  return '';
}

function parseClaudeResetDate(text, now = new Date()) {
  let raw = String(text || '').trim();
  if (!raw) return null;
  raw = raw.replace(/^resets?:?\s*/i, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\bat\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;

  const timeOnly = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (timeOnly) {
    const { hour, minute } = parseClock(timeOnly[1], timeOnly[2], timeOnly[3]);
    const date = new Date(now);
    date.setHours(hour, minute, 0, 0);
    if (date <= now) date.setDate(date.getDate() + 1);
    return date.toISOString();
  }

  const monthDate = raw.match(/^([a-z]{3,4})\s+(\d{1,2})(?:,?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (monthDate) {
    const month = MONTHS[monthDate[1].toLowerCase()];
    if (month === undefined) return null;
    const date = new Date(now);
    date.setMonth(month, Number(monthDate[2]));
    if (monthDate[3]) {
      const { hour, minute } = parseClock(monthDate[3], monthDate[4], monthDate[5]);
      date.setHours(hour, minute, 0, 0);
    } else {
      date.setHours(0, 0, 0, 0);
    }
    if (date <= now) date.setFullYear(date.getFullYear() + 1);
    return date.toISOString();
  }
  return null;
}

function parseClaudeCliUsageText(text, now = new Date()) {
  const clean = stripAnsiCodes(text);
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sessionPercentLeft = extractClaudePercent(lines, 'Current session');
  const weeklyPercentLeft = extractClaudePercent(lines, 'Current week');
  const resetLines = allClaudeResetLines(lines);
  let primaryResetDescription = extractClaudeReset(lines, 'Current session');
  let secondaryResetDescription = extractClaudeReset(lines, 'Current week');
  const sessionReset = resetLines.find((line) => claudeResetShape(line) === 'time') || '';
  const weeklyReset = resetLines.find((line) => claudeResetShape(line) === 'date') || '';
  if (!primaryResetDescription && sessionReset) primaryResetDescription = sessionReset;
  if (!secondaryResetDescription || (weeklyReset && claudeResetShape(secondaryResetDescription) === 'time')) {
    secondaryResetDescription = weeklyReset || secondaryResetDescription;
  }
  const accountEmail = (clean.match(/(?:Account|Email):\s*([^\s@]+@[^\s@]+)/i) || [])[1] || '';
  const accountOrganization = ((clean.match(/(?:Org|Organization):\s*(.+)/i) || [])[1] || '').trim();
  const accountLabel = planLabelFromParts((clean.match(/(?:Plan|Subscription):\s*([A-Za-z][A-Za-z0-9 _-]{0,30})/i) || [])[1] || '');
  if (sessionPercentLeft === null) throw errorWithStatus('unavailable', 'Claude CLI usage missing current session');
  return {
    sessionPercentLeft,
    weeklyPercentLeft,
    primaryResetDescription,
    secondaryResetDescription,
    primaryResetsAt: parseClaudeResetDate(primaryResetDescription, now),
    secondaryResetsAt: parseClaudeResetDate(secondaryResetDescription, now),
    accountEmail,
    accountName: accountOrganization,
    accountLabel,
    accountKey: [accountEmail, accountOrganization].filter(Boolean).join('|') || 'claude-cli'
  };
}

function cliWindow(kind, percentLeft, resetDescription, resetsAt, windowMinutes) {
  if (percentLeft === null || percentLeft === undefined) return null;
  return {
    kind,
    usedPercent: Math.max(0, Math.min(100, 100 - Number(percentLeft))),
    resetsAt,
    resetDescription,
    windowMinutes
  };
}

function mapClaudeCliUsageToProvider(text, meta = {}) {
  const parsed = parseClaudeCliUsageText(text, meta.now || new Date());
  const windows = [
    cliWindow('session', parsed.sessionPercentLeft, parsed.primaryResetDescription, parsed.primaryResetsAt, CLAUDE_SESSION_WINDOW_MINUTES),
    cliWindow('weekly', parsed.weeklyPercentLeft, parsed.secondaryResetDescription, parsed.secondaryResetsAt, CLAUDE_WEEKLY_WINDOW_MINUTES)
  ].filter(Boolean);
  return normalizeLimitProvider({
    provider: 'claude',
    accountKey: hashKey('claude-cli', parsed.accountKey),
    accountLabel: parsed.accountLabel,
    accountName: parsed.accountName,
    accountEmail: parsed.accountEmail,
    source: 'cli',
    status: 'ok',
    updatedAt: meta.updatedAt,
    windows
  });
}

function claudeCommandCandidates(env = process.env, platform = process.platform) {
  if (env.TOKEN_MONITOR_CLAUDE_COMMAND) return [env.TOKEN_MONITOR_CLAUDE_COMMAND];
  const candidates = [];
  const pathApi = pathApiForPlatform(platform);
  if (platform === 'win32') {
    const localAppData = envValue(env, 'LOCALAPPDATA');
    const appData = envValue(env, 'APPDATA');
    const userProfile = envValue(env, 'USERPROFILE');
    if (localAppData) {
      candidates.push(
        pathApi.join(localAppData, 'Programs', 'claude', 'claude.exe'),
        pathApi.join(localAppData, 'npm', 'claude.cmd'),
        pathApi.join(localAppData, 'Volta', 'tools', 'image', 'packages', '@anthropic-ai', 'claude-code', 'bin', 'claude.cmd'),
        pathApi.join(localAppData, 'fnm_multishells', 'claude.cmd')
      );
    }
    if (appData) candidates.push(pathApi.join(appData, 'npm', 'claude.cmd'));
    if (userProfile) candidates.push(pathApi.join(userProfile, '.npm-global', 'claude.cmd'));
    candidates.push('claude.cmd', 'claude.exe');
  } else {
    if (env.HOME) {
      candidates.push(
        path.join(env.HOME, '.npm-global', 'bin', 'claude'),
        path.join(env.HOME, '.local', 'bin', 'claude')
      );
    }
    candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude');
  }
  candidates.push('claude');
  return uniqueStrings(candidates);
}

function existingClaudeCommandCandidates(candidates, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const pathApi = pathApiForPlatform(deps.platform || process.platform);
  return candidates.filter((candidate) => {
    if (!pathApi.isAbsolute(candidate)) return true;
    return existsSync(candidate);
  });
}

function withClaudePathHints(env = process.env, platform = process.platform) {
  const delimiter = pathDelimiterForPlatform(platform);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const currentPath = env[pathKey] || '';
  const pathApi = pathApiForPlatform(platform);
  const hints = [];
  if (platform === 'win32') {
    const localAppData = envValue(env, 'LOCALAPPDATA');
    const appData = envValue(env, 'APPDATA');
    const userProfile = envValue(env, 'USERPROFILE');
    if (localAppData) {
      hints.push(
        pathApi.join(localAppData, 'Programs', 'claude'),
        pathApi.join(localAppData, 'npm'),
        pathApi.join(localAppData, 'Volta', 'tools', 'image', 'packages', '@anthropic-ai', 'claude-code', 'bin'),
        pathApi.join(localAppData, 'fnm_multishells')
      );
    }
    if (appData) hints.push(pathApi.join(appData, 'npm'));
    if (userProfile) hints.push(pathApi.join(userProfile, '.npm-global'));
  } else {
    hints.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
    if (env.HOME) hints.push(path.join(env.HOME, '.npm-global', 'bin'), path.join(env.HOME, '.local', 'bin'));
  }
  return {
    ...env,
    [pathKey]: uniqueStrings([...hints, ...currentPath.split(delimiter)]).join(delimiter)
  };
}

function claudePtyPythonScript() {
  return `
import fcntl, os, pty, re, select, signal, subprocess, sys, time
cmd = os.environ.get("TOKEN_MONITOR_CLAUDE_COMMAND_PATH", "claude")
cwd = os.environ.get("TOKEN_MONITOR_CLAUDE_PROBE_DIR") or os.getcwd()
timeout = float(os.environ.get("TOKEN_MONITOR_CLAUDE_CLI_TIMEOUT", "35"))
slash_command = os.environ.get("TOKEN_MONITOR_CLAUDE_SLASH_COMMAND", "/usage")
exit_marker = os.environ.get("TOKEN_MONITOR_CLAUDE_EXIT_MARKER_REGEX", "currentsession.*?[0-9]{1,3}(?:\\\\.[0-9]+)?%")
exit_pattern = re.compile(exit_marker) if exit_marker else None
os.makedirs(os.path.join(cwd, ".claude"), exist_ok=True)
settings_path = os.path.join(cwd, ".claude", "settings.local.json")
if not os.path.exists(settings_path):
    open(settings_path, "w").write('{"disableDeepLinkRegistration":"disable"}\\n')
master, slave = pty.openpty()
proc = subprocess.Popen([cmd, "--allowed-tools", ""], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, close_fds=True, start_new_session=True)
os.close(slave)
fcntl.fcntl(master, fcntl.F_SETFL, os.O_NONBLOCK)
ansi = re.compile(rb"\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b[()][A-Za-z0-9]|\\x1b[78=>][^\\x1b]*")
def compact(data):
    text = ansi.sub(b"", data).decode("utf-8", "ignore").lower()
    return re.sub(r"[^a-z0-9%]+", "", text)
buf = b""
start = time.time()
last_enter = 0
sent_cmd = False
slash_bytes = (slash_command + "\\r").encode("utf-8")
try:
    while time.time() - start < timeout:
        readable, _, _ = select.select([master], [], [], 0.08)
        if readable:
            try:
                chunk = os.read(master, 8192)
                if chunk:
                    buf += chunk
            except BlockingIOError:
                pass
        scan = compact(buf[-20000:])
        now = time.time()
        if now - last_enter > 0.8 and any(token in scan for token in [
            "quicksafetycheck", "yesitrustthisfolder", "pressentertocontinue",
            "readytocodehere", "showplanusage", "showplan"
        ]):
            os.write(master, b"\\r")
            last_enter = now
        if not sent_cmd and now - start > 5:
            os.write(master, slash_bytes)
            sent_cmd = True
        if sent_cmd and now - last_enter > 0.8:
            os.write(master, b"\\r")
            last_enter = now
        if sent_cmd and exit_pattern is not None and exit_pattern.search(scan):
            time.sleep(2)
            break
    sys.stdout.buffer.write(buf)
finally:
    try:
        os.write(master, b"/exit\\r")
    except Exception:
        pass
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except Exception:
        pass
`.trim();
}

async function runClaudePtyProbe(slashCommand, exitMarkerRegex, deps = {}) {
  if ((deps.platform || process.platform) === 'win32') {
    throw errorWithStatus('unavailable', 'Claude CLI PTY probe is not available on Windows yet');
  }
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const command = existingClaudeCommandCandidates(claudeCommandCandidates(env, platform), deps)[0];
  if (!command) throw errorWithStatus('notConfigured', 'Claude CLI not found');
  const probeDir = deps.claudeProbeDir || path.join(os.tmpdir(), 'token-monitor-claude-probe');
  fs.mkdirSync(probeDir, { recursive: true });
  const runEnv = {
    ...env,
    TOKEN_MONITOR_CLAUDE_COMMAND_PATH: command,
    TOKEN_MONITOR_CLAUDE_PROBE_DIR: probeDir,
    TOKEN_MONITOR_CLAUDE_CLI_TIMEOUT: String(deps.claudeCliTimeoutSeconds || 35),
    TOKEN_MONITOR_CLAUDE_SLASH_COMMAND: slashCommand,
    TOKEN_MONITOR_CLAUDE_EXIT_MARKER_REGEX: exitMarkerRegex || ''
  };
  const pythonCandidates = deps.pythonCommand ? [deps.pythonCommand] : ['python3', 'python'];
  let lastError = null;
  for (const python of pythonCandidates) {
    try {
      return await runProcessText(python, ['-c', claudePtyPythonScript()], {
        ...deps,
        env: runEnv,
        cwd: probeDir,
        timeoutMs: Number(deps.claudeCliTimeoutMs || 45000)
      });
    } catch (error) {
      lastError = error;
      if (error.code && error.code !== 'ENOENT') break;
    }
  }
  throw lastError || errorWithStatus('unavailable', 'Python PTY runner unavailable');
}

async function runClaudeUsageCli(deps = {}) {
  if (deps.runClaudeUsageCli) return deps.runClaudeUsageCli();
  if ((deps.platform || process.platform) === 'win32') return runClaudeDirectUsageCli(deps);
  return runClaudePtyProbe('/usage', 'currentsession.*?[0-9]{1,3}(?:\\.[0-9]+)?%', deps);
}

function runClaudeDirectUsageCli(deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const command = existingClaudeCommandCandidates(claudeCommandCandidates(env, platform), deps)[0];
  if (!command) throw errorWithStatus('notConfigured', 'Claude CLI not found');
  return runProcessText(command, ['/usage'], {
    ...deps,
    env: withClaudePathHints(env, platform),
    shell: platform === 'win32',
    timeoutMs: Number(deps.claudeDirectCliTimeoutMs || 12000)
  });
}

async function touchClaudeAuthPath(deps = {}) {
  if (deps.touchClaudeAuthPath) return deps.touchClaudeAuthPath();
  // Spawn `claude /status` in PTY to let Claude Code itself perform an auth check
  // and refresh the OAuth token if needed. We don't parse output — the side-effect
  // (mutated credentials file / Keychain entry) is the signal. Permissive exit
  // marker matches common /status output tokens so we exit promptly on success.
  return runClaudePtyProbe('/status', '(?:loggedin|subscription|account|model|version|email|organization)', {
    ...deps,
    claudeCliTimeoutSeconds: deps.claudeStatusTimeoutSeconds || 20,
    claudeCliTimeoutMs: deps.claudeStatusTimeoutMs || 25000
  });
}

function codexWindowKind(name, window) {
  const mins = Number(window?.windowDurationMins || window?.window_duration_mins || 0);
  // Monthly quotas use the shared wire contract's billing lane. The display
  // label below keeps the cadence explicit instead of presenting it as money.
  if (mins === 30 * 24 * 60) return 'billing';
  if (mins >= 7 * 24 * 60) return 'weekly';
  if (mins === 5 * 60) return 'session';
  if (String(name).toLowerCase() === 'secondary') return 'weekly';
  return 'session';
}

function hasCodexRateLimitWindows(snapshot) {
  return Boolean(snapshot && typeof snapshot === 'object' && (snapshot.primary || snapshot.secondary));
}

function codexRateLimitsById(payload = {}) {
  return payload.rateLimitsByLimitId || payload.rate_limits_by_limit_id || {};
}

function codexDirectRateLimits(payload = {}) {
  return payload.rateLimits || payload.rate_limits || {};
}

function codexRateLimitWindowSignature(snapshot) {
  return JSON.stringify(['primary', 'secondary'].map((key) => {
    const window = snapshot?.[key];
    if (!window) return null;
    return [
      key,
      window.usedPercent ?? window.used_percent ?? null,
      window.resetsAt ?? window.resets_at ?? null,
      window.windowDurationMins ?? window.window_duration_mins ?? null
    ];
  }));
}

function codexAlternatePlanType(snapshot) {
  const value = snapshot?.planType ?? snapshot?.plan_type;
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function codexAlternateResetCredits(snapshot) {
  const resetCredits = snapshot?.rateLimitResetCredits ?? snapshot?.rate_limit_reset_credits;
  return normalizeLimitProvider({ provider: 'codex', resetCredits }).resetCredits;
}

function unambiguousAlternateCodexRateLimits(rateLimitsById) {
  // Object key order is not a quota-selection contract. Keep agreed window
  // data, but only carry optional metadata when every alternate agrees too.
  const candidates = Object.entries(rateLimitsById)
    .filter(([id, snapshot]) => id !== 'codex' && hasCodexRateLimitWindows(snapshot))
    .sort(([left], [right]) => left.localeCompare(right));
  if (candidates.length === 0) return null;
  const signatures = new Set(candidates.map(([, snapshot]) => codexRateLimitWindowSignature(snapshot)));
  if (signatures.size !== 1) return null;

  const snapshots = candidates.map(([, snapshot]) => snapshot);
  const first = snapshots[0];
  const consensus = {
    ...(first.primary ? { primary: first.primary } : {}),
    ...(first.secondary ? { secondary: first.secondary } : {})
  };
  const planTypes = snapshots.map(codexAlternatePlanType);
  const normalizedPlanTypes = new Set(planTypes.map((value) => value?.toLowerCase() || null));
  if (normalizedPlanTypes.size === 1 && planTypes[0]) consensus.planType = planTypes[0];

  const resetCredits = snapshots.map(codexAlternateResetCredits);
  const resetCreditSignatures = new Set(resetCredits.map((value) => JSON.stringify(value)));
  if (resetCreditSignatures.size === 1 && resetCredits[0]) {
    consensus.rateLimitResetCredits = resetCredits[0];
  }
  return consensus;
}

function codexRateLimitSnapshot(payload = {}) {
  const rateLimitsById = codexRateLimitsById(payload);
  const direct = codexDirectRateLimits(payload);
  if (hasCodexRateLimitWindows(rateLimitsById.codex)) return rateLimitsById.codex;
  if (hasCodexRateLimitWindows(direct)) return direct;
  const alternate = unambiguousAlternateCodexRateLimits(rateLimitsById);
  if (alternate) return alternate;
  return rateLimitsById.codex || direct || {};
}

function codexResetCreditsSnapshot(payload = {}) {
  const rateLimits = codexRateLimitSnapshot(payload);
  return payload.rateLimitResetCredits
    || payload.rate_limit_reset_credits
    || rateLimits.rateLimitResetCredits
    || rateLimits.rate_limit_reset_credits
    || null;
}

function codexAccessTokenFromAuth(auth) {
  const tokens = auth?.tokens || auth || {};
  return String(tokens.access_token || auth?.access_token || '').trim();
}

function codexProviderAccountIdFromAuth(auth) {
  return codexAuthIdentity(auth).providerAccountId;
}

function parseCodexChatGptBaseUrl(configContents) {
  for (const rawLine of String(configContents || '').split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const match = /^chatgpt_base_url\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    return match[1].trim().replace(/^["']|["']$/g, '').trim();
  }
  return '';
}

function normalizeCodexChatGptBaseUrl(value) {
  let normalized = String(value || '').trim() || CODEX_CHATGPT_BASE_URL;
  normalized = normalized.replace(/\/+$/, '');
  if (/^https:\/\/(?:chatgpt|chat)\.openai\.com$/i.test(normalized) || /^https:\/\/chatgpt\.com$/i.test(normalized)) {
    normalized += '/backend-api';
  }
  return normalized;
}

function codexChatGptBaseUrl(deps = {}) {
  const env = deps.env || process.env;
  const read = deps.readFileSync || fs.readFileSync;
  const base = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configPath = deps.codexConfigPath || path.join(base, 'config.toml');
  try {
    const parsed = parseCodexChatGptBaseUrl(read(configPath, 'utf8'));
    if (parsed) return normalizeCodexChatGptBaseUrl(parsed);
  } catch (_) {}
  return CODEX_CHATGPT_BASE_URL;
}

function parseCodexResetCreditsPayload(payload, nowMs = Date.now()) {
  const availableCount = Number(payload?.available_count ?? payload?.availableCount);
  if (!Number.isFinite(availableCount) || availableCount < 0) {
    throw errorWithStatus('unavailable', 'Invalid Codex reset credits response');
  }
  const expirations = [];
  for (const credit of Array.isArray(payload?.credits) ? payload.credits : []) {
    const status = String(credit?.status || '').toLowerCase();
    if (status !== 'available') continue;
    const expiresAt = credit?.expires_at ?? credit?.expiresAt;
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) continue;
    expirations.push(new Date(expiresMs).toISOString());
  }
  expirations.sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    availableCount: Math.floor(availableCount),
    nextExpiresAt: expirations[0] || null,
    ...(expirations.length > 0 ? { expirations } : {})
  };
}

async function fetchCodexResetCredits(deps = {}) {
  const read = deps.readFileSync || fs.readFileSync;
  const authPath = deps.codexAuthPath || codexAuthPath(deps.env || process.env);
  let auth;
  try {
    auth = JSON.parse(read(authPath, 'utf8'));
  } catch (_) {
    throw errorWithStatus('notConfigured', 'Codex auth.json not found');
  }
  const accessToken = codexAccessTokenFromAuth(auth);
  if (!accessToken) throw errorWithStatus('unauthorized', 'Codex access token not found');

  const fetchFn = deps.fetch || fetch;
  const timeoutMs = Number(deps.codexResetCreditsTimeoutMs || 4000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const url = `${codexChatGptBaseUrl(deps)}${CODEX_RESET_CREDITS_PATH}`;
  const accountId = deps.codexAccountId || codexProviderAccountIdFromAuth(auth);
  try {
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'user-agent': TOKEN_MONITOR_USER_AGENT,
      'openai-beta': 'codex-1',
      originator: 'Codex Desktop'
    };
    if (accountId) headers['chatgpt-account-id'] = accountId;
    const response = await fetchFn(url, {
      method: 'GET',
      headers,
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw errorWithStatus(status, `rate-limit-reset-credits returned ${response.status}`);
    }
    const json = await response.json();
    return parseCodexResetCreditsPayload(json, (deps.now || Date.now)());
  } catch (error) {
    if (error?.name === 'AbortError') throw errorWithStatus('unavailable', 'rate-limit-reset-credits timed out');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mergeCodexResetCredits(primary, fallback) {
  const first = primary && typeof primary === 'object' ? primary : null;
  const second = fallback && typeof fallback === 'object' ? fallback : null;
  if (!first) return second;
  if (!second) return first;
  const expirations = first.expirations ?? first.expirationTimes ?? first.expiresAtList ?? first.expires_at_list
    ?? second.expirations ?? second.expirationTimes ?? second.expiresAtList ?? second.expires_at_list;
  return {
    availableCount: first.availableCount ?? first.available_count ?? second.availableCount ?? second.available_count,
    nextExpiresAt: first.nextExpiresAt ?? first.next_expires_at ?? first.expiresAt ?? first.expires_at
      ?? second.nextExpiresAt ?? second.next_expires_at ?? second.expiresAt ?? second.expires_at,
    ...(expirations ? { expirations } : {})
  };
}

async function readCodexResetCredits(deps = {}) {
  if (deps.readCodexResetCredits) return deps.readCodexResetCredits(deps);
  return fetchCodexResetCredits(deps);
}

async function withCodexOAuthResetCredits(payload, deps = {}) {
  const existing = codexResetCreditsSnapshot(payload);
  try {
    const oauthResetCredits = await readCodexResetCredits(deps);
    return {
      ...payload,
      rateLimitResetCredits: mergeCodexResetCredits(oauthResetCredits, existing)
    };
  } catch (_) {
    return payload;
  }
}

function codexAccountLabel(payload = {}) {
  return codexPlanLabelFromParts(...codexPlanParts(payload));
}

function codexPlanParts(payload = {}) {
  const snapshot = codexRateLimitSnapshot(payload);
  const direct = codexDirectRateLimits(payload);
  const codexSnapshot = codexRateLimitsById(payload).codex || {};
  const account = payload.account || {};
  return [
    snapshot.planType,
    snapshot.plan_type,
    direct.planType,
    direct.plan_type,
    codexSnapshot.planType,
    codexSnapshot.plan_type,
    account.planType,
    account.plan_type,
    account.loginMethod,
    account.login_method,
    account.plan,
    account.subscription?.planType,
    account.subscription?.plan_type,
    account.subscription?.plan
  ];
}

function codexPlanCanHaveQuotaWindows(payload = {}) {
  const raw = codexPlanParts(payload).filter(Boolean).join(' ').toLowerCase();
  return !(raw.includes('usage_based') || raw.includes('usage based') || raw.includes('cbp'));
}

function shouldRetryCodexEmptyQuotaPayload(payload = {}) {
  if (hasCodexRateLimitWindows(codexRateLimitSnapshot(payload))) return false;
  if (!codexPlanCanHaveQuotaWindows(payload)) return false;
  const account = payload.account || {};
  return Boolean(
    codexAccountLabel(payload)
    || account.email
    || account.planType
    || account.plan_type
    || account.type
  );
}

async function waitForCodexEmptyQuotaRetry(deps = {}) {
  const delayMs = Number(deps.codexEmptyQuotaRetryDelayMs ?? CODEX_EMPTY_QUOTA_RETRY_DELAY_MS);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  if (deps.signal?.aborted) throw abortError(deps.signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => finish(abortError(deps.signal));
    function finish(error) {
      clearTimeout(timer);
      deps.signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    deps.signal?.addEventListener?.('abort', onAbort, { once: true });
    if (deps.signal?.aborted) onAbort();
  });
}

function mapCodexRateLimitsToProvider(payload, meta = {}) {
  const rateLimits = codexRateLimitSnapshot(payload);
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const window = rateLimits[key];
    if (!window) continue;
    const kind = codexWindowKind(key, window);
    windows.push({
      kind,
      ...(kind === 'billing' ? { label: 'Monthly' } : {}),
      usedPercent: window.usedPercent ?? window.used_percent,
      resetsAt: window.resetsAt ?? window.resets_at,
      windowMinutes: window.windowDurationMins ?? window.window_duration_mins
    });
  }
  return normalizeLimitProvider({
    provider: 'codex',
    accountKey: meta.accountKey || '',
    accountLabel: meta.accountLabel || codexAccountLabel(payload),
    accountName: meta.accountName || '',
    accountEmail: meta.accountEmail || payload.account?.email || '',
    workspaceKind: meta.workspaceKind || '',
    source: meta.source || 'rpc',
    sourceDetail: meta.sourceDetail || payload.sourceDetail,
    status: 'ok',
    updatedAt: meta.updatedAt,
    windows,
    resetCredits: codexResetCreditsSnapshot(payload)
  });
}

function pathDelimiterForPlatform(platform = process.platform) {
  return platform === 'win32' ? ';' : ':';
}

function withCodexPathHints(env = process.env, platform = process.platform) {
  const delimiter = pathDelimiterForPlatform(platform);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const currentPath = env[pathKey] || '';
  const pathApi = pathApiForPlatform(platform);
  const hints = [];
  if (platform === 'win32') {
    const appData = envValue(env, 'APPDATA');
    const localAppData = envValue(env, 'LOCALAPPDATA');
    const userProfile = envValue(env, 'USERPROFILE');
    if (appData) hints.push(pathApi.join(appData, 'npm'));
    if (localAppData) {
      hints.push(
        pathApi.join(localAppData, 'pnpm'),
        pathApi.join(localAppData, 'Microsoft', 'WindowsApps')
      );
    }
    if (userProfile) hints.push(pathApi.join(userProfile, '.bun', 'bin'));
  } else {
    hints.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
    if (env.HOME) {
      hints.push(
        path.join(env.HOME, '.npm-global', 'bin'),
        path.join(env.HOME, '.bun', 'bin'),
        path.join(env.HOME, '.local', 'bin')
      );
    }
  }
  return {
    ...env,
    [pathKey]: uniqueStrings([...hints, ...currentPath.split(delimiter)]).join(delimiter)
  };
}

function existingCodexCommandCandidates(candidates, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const pathApi = pathApiForPlatform(deps.platform || process.platform);
  return candidates.filter((candidate) => {
    if (!pathApi.isAbsolute(candidate)) return true;
    return existsSync(candidate);
  });
}

function codexSpawnSpec(command, platform = process.platform) {
  const args = ['-s', 'read-only', '-a', 'untrusted', 'app-server'];
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args };
  }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', [quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(' ')]
  };
}

function quoteWindowsCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function codexLoginSpawnSpec(command, platform = process.platform) {
  const args = ['login'];
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args };
  }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', [quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(' ')]
  };
}

// Absolute path on purpose: a bare `taskkill` is resolved through PATH, and a user
// PATH that lost %SystemRoot%\System32 turns every tree-kill into a spawn ENOENT.
function windowsTaskkillCommand(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'taskkill.exe');
}

function killCodexLoginProcess(child, platform = process.platform, deps = {}) {
  if (!child || typeof child.kill !== 'function') return;
  const spawnFn = deps.spawn || spawn;
  try {
    // Login spawns a browser/callback helper, so kill the whole tree, not just codex.
    if (platform === 'win32') {
      if (child.pid) {
        try {
          const killer = spawnFn(
            windowsTaskkillCommand(deps.env || process.env),
            ['/pid', String(child.pid), '/t', '/f'],
            { windowsHide: true }
          );
          // spawn() reports a missing or blocked taskkill.exe asynchronously as an
          // 'error' event, so the enclosing try/catch never sees it. Without a
          // listener the EventEmitter rethrows and crashes the main process.
          killer?.on?.('error', () => {});
        } catch (_) {}
      }
      child.kill();
      return;
    }
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); return; } catch (_) {}
    }
    child.kill('SIGTERM');
  } catch (_) {}
}

// Runs `codex login` with CODEX_HOME scoped to an isolated managed home so the
// account gets its own OAuth grant, fully decoupled from the user's live Codex
// CLI login. Returns { outcome, exitCode, output }; output is streamed to
// options.onOutput as it arrives (so the renderer can surface the login URL).
function runCodexLoginWithCommand(command, options = {}, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const signal = options.signal || deps.signal;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const onOutput = typeof options.onOutput === 'function' ? options.onOutput : () => {};
  const timeoutMs = Number(options.timeoutMs || deps.codexLoginTimeoutMs || 180000);
  if (signal?.aborted) return Promise.resolve({ outcome: 'cancelled', exitCode: null, output: '' });
  const spec = codexLoginSpawnSpec(command, platform);
  let child;
  try {
    child = spawnFn(spec.command, spec.args, {
      windowsHide: true,
      detached: platform !== 'win32',
      env: { ...withCodexPathHints(env, platform), CODEX_HOME: options.homePath }
    });
  } catch (error) {
    if (signal?.aborted) return Promise.resolve({ outcome: 'cancelled', exitCode: null, output: '' });
    return Promise.resolve({ outcome: 'launchFailed', exitCode: null, output: String(error?.message || error) });
  }

  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timer = null;
    const append = (chunk) => {
      const text = chunk == null ? '' : String(chunk);
      if (!text) return;
      output += text;
      if (output.length > 8000) output = output.slice(-8000);
      onOutput(text);
    };
    const finish = (outcome, exitCode) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimer(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ outcome, exitCode: exitCode ?? null, output: output.trim() });
    };
    const onAbort = () => {
      killCodexLoginProcess(child, platform, { spawn: spawnFn, env });
      finish('cancelled', null);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (error) => { append(String(error?.message || error)); finish('launchFailed', null); });
    child.on('close', (code) => finish(code === 0 ? 'success' : 'failed', code));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimer(() => {
      killCodexLoginProcess(child, platform, { spawn: spawnFn, env });
      finish('timedOut', null);
    }, timeoutMs);
  });
}

function shouldTryNextCodexLoginCommand(result) {
  if (result?.outcome === 'launchFailed') return true;
  if (result?.outcome !== 'failed') return false;
  const output = String(result.output || '').toLowerCase();
  return (
    output.includes('enoent') ||
    output.includes('not recognized as an internal or external command') ||
    output.includes('command not found') ||
    output.includes('no such file or directory') ||
    output.includes('the system cannot find the file specified') ||
    output.includes('the system cannot find the path specified')
  );
}

function codexLoginAttemptsOutput(attempts) {
  if (attempts.length <= 1) return attempts[0]?.result.output || '';
  return attempts.map(({ command, result }) => {
    const detail = String(result.output || '').trim();
    return detail ? `${command}: ${detail}` : `${command}: ${result.outcome}`;
  }).join('\n\n');
}

async function runCodexLogin(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const commands = codexRpcCommandCandidates({ ...deps, env, platform });
  if (commands.length === 0) return { outcome: 'missingBinary', exitCode: null, output: '' };

  const attempts = [];
  for (const command of commands) {
    if (options.signal?.aborted) return { outcome: 'cancelled', exitCode: null, output: '' };
    const result = await runCodexLoginWithCommand(command, options, { ...deps, env, platform });
    attempts.push({ command, result });
    if (!shouldTryNextCodexLoginCommand(result)) return result;
  }

  const result = attempts.at(-1).result;
  return { ...result, output: codexLoginAttemptsOutput(attempts) };
}

function spawnCodexAppServer(deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const command = deps.codexCommand || existingCodexCommandCandidates(codexCommandCandidates(env, platform, deps), deps)[0];
  if (!command) throw errorWithStatus('notConfigured', 'Codex CLI not found');
  const spec = codexSpawnSpec(command, platform);
  return spawnFn(spec.command, spec.args, {
    windowsHide: true,
    env: withCodexPathHints(env, platform)
  });
}

function codexRpcCommandCandidates(deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  if (deps.codexCommand) return [deps.codexCommand];
  return existingCodexCommandCandidates(codexCommandCandidates(env, platform, deps), deps);
}

function windowsCodexBinCandidates(binDir, deps = {}) {
  const pathApi = pathApiForPlatform('win32');
  const candidates = [pathApi.join(binDir, 'codex.exe')];
  const readdirSync = deps.readdirSync || fs.readdirSync;
  let entries;
  try {
    entries = readdirSync(binDir, { withFileTypes: true });
  } catch (_) {
    return candidates;
  }
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof entry?.isDirectory === 'function' && !entry.isDirectory()) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(name || '')) continue;
    candidates.push(pathApi.join(binDir, name, 'codex.exe'));
  }
  return candidates;
}

function windowsCodexPackageVersion(name) {
  const match = /^OpenAI\.Codex_(\d+(?:\.\d+)*)_/.exec(String(name || ''));
  if (!match) return [];
  return match[1].split('.').map((part) => Number(part) || 0);
}

function compareWindowsCodexPackages(a, b) {
  const aName = typeof a === 'string' ? a : a?.name;
  const bName = typeof b === 'string' ? b : b?.name;
  const aVersion = windowsCodexPackageVersion(aName);
  const bVersion = windowsCodexPackageVersion(bName);
  const length = Math.max(aVersion.length, bVersion.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (bVersion[i] || 0) - (aVersion[i] || 0);
    if (diff) return diff;
  }
  return String(aName || '').localeCompare(String(bName || ''));
}

function windowsCodexStoreCandidates(env = process.env, deps = {}) {
  const pathApi = pathApiForPlatform('win32');
  const candidates = [];
  const localAppData = envValue(env, 'LOCALAPPDATA');
  if (localAppData) {
    candidates.push(...windowsCodexBinCandidates(pathApi.join(localAppData, 'OpenAI', 'Codex', 'bin'), deps));
    const packagesDir = pathApi.join(localAppData, 'Packages');
    let packageEntries = [];
    try {
      packageEntries = (deps.readdirSync || fs.readdirSync)(packagesDir, { withFileTypes: true });
    } catch (_) {}
    for (const entry of packageEntries.sort(compareWindowsCodexPackages)) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (typeof entry?.isDirectory === 'function' && !entry.isDirectory()) continue;
      if (!/^OpenAI\.Codex_[^\\/:*?"<>|]+$/.test(name || '')) continue;
      candidates.push(...windowsCodexBinCandidates(
        pathApi.join(packagesDir, name, 'LocalCache', 'Local', 'OpenAI', 'Codex', 'bin'),
        deps
      ));
    }
    const aliasDir = pathApi.join(localAppData, 'Microsoft', 'WindowsApps');
    candidates.push(pathApi.join(aliasDir, 'codex.exe'), pathApi.join(aliasDir, 'Codex.exe'));
  }

  const readdirSync = deps.readdirSync || fs.readdirSync;
  for (const root of uniqueStrings([
    envValue(env, 'PROGRAMFILES'),
    envValue(env, 'ProgramW6432')
  ])) {
    const appxDir = pathApi.join(root, 'WindowsApps');
    let entries;
    try {
      entries = readdirSync(appxDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries.sort(compareWindowsCodexPackages)) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (typeof entry?.isDirectory === 'function' && !entry.isDirectory()) continue;
      if (!/^OpenAI\.Codex_[^\\/:*?"<>|]+$/.test(name || '')) continue;
      candidates.push(
        pathApi.join(appxDir, name, 'app', 'resources', 'codex.exe'),
        pathApi.join(appxDir, name, 'app', 'Codex.exe')
      );
    }
  }
  return candidates;
}

function codexCommandCandidates(env = process.env, platform = process.platform, deps = {}) {
  if (env.TOKEN_MONITOR_CODEX_COMMAND) return [env.TOKEN_MONITOR_CODEX_COMMAND];
  const pathApi = pathApiForPlatform(platform);
  const candidates = [];
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex'
    );
  } else if (platform === 'win32') {
    const localAppData = envValue(env, 'LOCALAPPDATA');
    const programFiles = envValue(env, 'PROGRAMFILES');
    const programFilesX86 = envValue(env, 'PROGRAMFILES(X86)');
    const appData = envValue(env, 'APPDATA');
    if (localAppData) candidates.push(pathApi.join(localAppData, 'Programs', 'Codex', 'resources', 'codex.exe'));
    if (programFiles) candidates.push(pathApi.join(programFiles, 'Codex', 'resources', 'codex.exe'));
    if (programFilesX86) candidates.push(pathApi.join(programFilesX86, 'Codex', 'resources', 'codex.exe'));
    candidates.push(...windowsCodexStoreCandidates(env, deps));
    if (appData) candidates.push(pathApi.join(appData, 'npm', 'codex.cmd'));
    candidates.push('codex.cmd', 'codex.exe');
    if (localAppData) candidates.push(pathApi.join(localAppData, 'Programs', 'Codex', 'Codex.exe'));
  }
  candidates.push('codex');
  return uniqueStrings(candidates);
}

function codexCommandSourceDetail(command, platform = process.platform) {
  const raw = String(command || '').trim();
  if (!raw) return 'unknown';
  const normalized = raw.replace(/\\/g, '/').toLowerCase();

  if (normalized.includes('/codex.app/') || normalized.includes('/chatgpt.app/')) return 'app';
  if (platform === 'win32') {
    if (
      normalized.includes('/programs/codex/') ||
      normalized.includes('/openai/codex/bin/') ||
      normalized.includes('/packages/openai.codex_') ||
      normalized.includes('/windowsapps/openai.codex_') ||
      normalized.includes('/microsoft/windowsapps/')
    ) {
      return 'app';
    }
    if (
      normalized === 'codex' ||
      normalized === 'codex.cmd' ||
      normalized === 'codex.exe' ||
      normalized.includes('/npm/codex.cmd') ||
      normalized.includes('/node_modules/@openai/codex/') ||
      normalized.includes('/.bun/bin/codex.exe')
    ) {
      return 'cli';
    }
  }
  if (/(^|\/)codex(\.cmd|\.exe)?$/.test(normalized)) return 'cli';
  return 'unknown';
}

function createJsonRpcClient(child, timeoutMs) {
  let nextId = 1;
  let buffer = '';
  let closed = false;
  const pending = new Map();

  function rejectAll(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  function abort(error) {
    closed = true;
    rejectAll(error);
  }

  function handleMessage(message) {
    if (!message || message.id === undefined || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
    else resolve(message.result);
  }

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try { handleMessage(JSON.parse(line)); } catch (_) {}
    }
  });
  child.on('error', (error) => {
    closed = true;
    rejectAll(error);
  });
  child.on('close', (code) => {
    closed = true;
    rejectAll(new Error(`codex app-server exited ${code}`));
  });

  function send(method, params) {
    if (closed) return Promise.reject(new Error('codex app-server is closed'));
    const id = nextId++;
    const message = params === undefined ? { method, id } : { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  function notify(method, params) {
    if (!closed) child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  return { abort, send, notify, rejectAll };
}

function shouldTryNextCodexCommand(error) {
  if (error?.code === 'ENOENT') return true;
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('app-server exited') ||
    message.includes('initialize timed out') ||
    message.includes('enoent') ||
    message.includes('not recognized') ||
    message.includes('not found')
  );
}

function codexRpcPayload(rateLimitResult, account, command, deps = {}) {
  const rateLimitsByLimitId = rateLimitResult?.rateLimitsByLimitId || rateLimitResult?.rate_limits_by_limit_id || {};
  const rateLimits = rateLimitResult?.rateLimits || rateLimitResult?.rate_limits || rateLimitsByLimitId.codex || {};
  return {
    account,
    rateLimits,
    rateLimitsByLimitId,
    rateLimitResetCredits: rateLimitResult?.rateLimitResetCredits || rateLimitResult?.rate_limit_reset_credits || null,
    sourceDetail: codexCommandSourceDetail(command, deps.platform || process.platform)
  };
}

async function readCodexRpcWithCommand(command, deps = {}) {
  const timeoutMs = Number(deps.codexRpcTimeoutMs || CODEX_RPC_TIMEOUT_MS);
  const platform = deps.platform || process.platform;
  const signal = deps.signal;
  if (signal?.aborted) throw abortError(signal);
  const child = spawnCodexAppServer({ ...deps, codexCommand: command });
  const rpc = createJsonRpcClient(child, timeoutMs);
  const onAbort = () => {
    rpc.abort(abortError(signal));
    killCodexLoginProcess(child, platform, deps);
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) throw abortError(signal);
    await rpc.send('initialize', {
      clientInfo: { name: 'token-monitor', title: 'Token Monitor', version: appVersion() }
    });
    rpc.notify('initialized', {});
    let rateLimitResult = await rpc.send('account/rateLimits/read');
    const accountResult = await rpc.send('account/read').catch(() => {
      if (signal?.aborted) throw abortError(signal);
      return null;
    });
    const account = accountResult?.account || null;
    let payload = codexRpcPayload(rateLimitResult, account, command, deps);
    if (deps.codexEmptyQuotaRetry !== false && shouldRetryCodexEmptyQuotaPayload(payload)) {
      await waitForCodexEmptyQuotaRetry(deps);
      try {
        rateLimitResult = await rpc.send('account/rateLimits/read');
        const retryPayload = codexRpcPayload(rateLimitResult, account, command, deps);
        if (hasCodexRateLimitWindows(codexRateLimitSnapshot(retryPayload))) {
          payload = {
            ...retryPayload,
            rateLimitResetCredits: retryPayload.rateLimitResetCredits || payload.rateLimitResetCredits
          };
        }
      } catch (_) {
        if (signal?.aborted) throw abortError(signal);
      }
    }
    if (!account && !hasCodexRateLimitWindows(codexRateLimitSnapshot(payload))) {
      throw errorWithStatus('notConfigured', 'Codex account not configured');
    }
    if (signal?.aborted) throw abortError(signal);
    return payload;
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    rpc.abort(new Error('codex app-server closed'));
    if (!signal?.aborted) killCodexLoginProcess(child, platform, deps);
  }
}

async function readCodexRpc(deps = {}) {
  const commands = codexRpcCommandCandidates(deps);
  if (commands.length === 0) throw errorWithStatus('notConfigured', 'Codex CLI not found');
  let lastError = null;
  for (const command of commands) {
    try {
      return await readCodexRpcWithCommand(command, deps);
    } catch (error) {
      lastError = error;
      if (deps.codexCommand || !shouldTryNextCodexCommand(error)) throw error;
    }
  }
  throw lastError || errorWithStatus('notConfigured', 'Codex CLI not found');
}

function normalizeCodexManagedAccounts(value) {
  if (!Array.isArray(value)) return [];
  return value.map((account) => {
    if (!account || typeof account !== 'object') return null;
    const id = String(account.id || '').trim();
    const homePath = String(account.homePath || account.codexHome || '').trim();
    if (!id || !homePath) return null;
    return {
      id,
      homePath,
      authPath: String(account.authPath || '').trim(),
      email: String(account.email || '').trim().toLowerCase(),
      accountKey: String(account.accountKey || '').trim(),
      accountLabel: String(account.accountLabel || account.plan || '').trim(),
      workspaceAccountId: String(account.workspaceAccountId || account.providerAccountId || '').trim().toLowerCase(),
      workspaceLabel: String(account.workspaceLabel || '').trim(),
      workspaceKind: account.workspaceKind === 'personal' ? 'personal' : '',
      enabled: account.enabled !== false
    };
  }).filter(Boolean);
}

function codexAccountKeyFromSeed(seed) {
  const raw = String(seed || '').trim();
  return raw.startsWith('sha256:') ? raw : hashKey('codex', raw || 'account');
}

function resolvedCodexAccountKey(email, workspaceAccountId, fallbackSeed) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedWorkspaceAccountId = String(workspaceAccountId || '').trim().toLowerCase();
  if (normalizedEmail && normalizedWorkspaceAccountId) {
    return codexAccountKey(normalizedEmail, normalizedWorkspaceAccountId);
  }
  return codexAccountKeyFromSeed(fallbackSeed || normalizedEmail || normalizedWorkspaceAccountId);
}

function managedCodexAccountKey(account, authIdentity = {}, resolvedEmail = '') {
  const email = String(resolvedEmail || authIdentity.email || account.email || '').trim().toLowerCase();
  const workspaceAccountId = String(
    authIdentity.workspaceAccountId
    || authIdentity.providerAccountId
    || account.workspaceAccountId
    || account.providerAccountId
    || ''
  ).trim().toLowerCase();
  return resolvedCodexAccountKey(
    email,
    workspaceAccountId,
    account.accountKey || authIdentity.accountKey || email || account.id || account.homePath
  );
}

async function fetchManagedCodexAccountLimits(account, _options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const env = {
    ...(deps.env || process.env),
    CODEX_HOME: account.homePath
  };
  const pathApi = pathApiForPlatform(deps.platform || process.platform);
  const accountDeps = {
    ...deps,
    env,
    codexAuthPath: account.authPath || pathApi.join(account.homePath, 'auth.json')
  };
  const reader = deps.readCodexRpc || readCodexRpc;
  const authIdentity = readLiveCodexIdentity(accountDeps);
  try {
    const payload = await withCodexOAuthResetCredits(await reader(accountDeps), accountDeps);
    const email = authIdentity.email || payload.account?.email || account.email;
    return mapCodexRateLimitsToProvider(payload, {
      accountKey: managedCodexAccountKey(account, authIdentity, email),
      accountEmail: email,
      accountLabel: codexAccountLabel(payload) || account.accountLabel,
      accountName: account.workspaceLabel,
      workspaceKind: account.workspaceKind,
      updatedAt: nowIso(nowMs),
      source: 'rpc',
      sourceDetail: 'managed'
    });
  } catch (error) {
    const email = authIdentity.email || account.email;
    return normalizeLimitProvider({
      provider: 'codex',
      accountKey: managedCodexAccountKey(account, authIdentity, email),
      accountEmail: email,
      accountLabel: account.accountLabel,
      accountName: account.workspaceLabel,
      workspaceKind: account.workspaceKind,
      source: 'rpc',
      sourceDetail: 'managed',
      status: providerStatusFromError(error),
      updatedAt: nowIso(nowMs),
      windows: []
    });
  }
}

// Reads the live login's identity (email + selected workspace id) from its
// auth.json. The RPC `account/read` often omits the email, so the JWT in
// auth.json is the reliable source. The shared composite key keeps the live
// account consistent with managed accounts for cross-device dedup.
function readLiveCodexIdentity(deps = {}) {
  const read = deps.readFileSync || fs.readFileSync;
  const authPath = deps.codexAuthPath || codexAuthPath(deps.env || process.env);
  try {
    return codexAuthIdentity(JSON.parse(read(authPath, 'utf8')));
  } catch (_) {
    return { email: '', accountLabel: '', providerAccountId: '', accountKey: '' };
  }
}

async function fetchLiveCodexAccount(deps = {}, nowMs = Date.now(), managedAccounts = []) {
  const reader = deps.readCodexRpc || readCodexRpc;
  const payload = await withCodexOAuthResetCredits(await reader(deps), deps);
  const authIdentity = readLiveCodexIdentity(deps);
  const email = authIdentity.email || payload.account?.email || '';
  const fallbackSeed = payload.account?.email || `${payload.account?.type || 'account'}:${payload.account?.planType || ''}:${deps.codexAuthPath || codexAuthPath(deps.env || process.env)}`;
  const accountKey = resolvedCodexAccountKey(
    email,
    authIdentity.workspaceAccountId || authIdentity.providerAccountId,
    authIdentity.accountKey || fallbackSeed
  );
  const matchingManagedAccount = managedAccounts.find(
    (account) => managedCodexAccountKey(account, {}, account.email) === accountKey
  );
  return mapCodexRateLimitsToProvider(payload, {
    accountKey,
    accountEmail: email,
    accountLabel: codexAccountLabel(payload),
    accountName: matchingManagedAccount?.workspaceLabel || '',
    workspaceKind: matchingManagedAccount?.workspaceKind || '',
    updatedAt: nowIso(nowMs),
    source: 'rpc',
    sourceDetail: payload.sourceDetail
  });
}

async function fetchCodexLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const scope = options.limitRefreshScope?.provider === 'codex'
    ? options.limitRefreshScope
    : null;
  const managedAccounts = normalizeCodexManagedAccounts(options.codexManagedAccounts || deps.codexManagedAccounts)
    .filter((account) => account.enabled !== false)
    .filter((account) => {
      if (!scope) return true;
      if (scope.sourceDetail && scope.sourceDetail !== 'managed') return false;
      const accountKey = managedCodexAccountKey(account, {}, account.email);
      if (scope.accountKey) return accountKey === scope.accountKey;
      if (scope.accountEmail) return account.email === scope.accountEmail;
      if (scope.accountLabel) return account.accountLabel === scope.accountLabel;
      return false;
    });
  let includeLiveAccount = options.includeLiveCodexAccount !== false;
  if (scope) {
    if (scope.sourceDetail) {
      includeLiveAccount = includeLiveAccount && scope.sourceDetail !== 'managed';
    } else if (scope.accountKey) {
      includeLiveAccount = includeLiveAccount && readLiveCodexIdentity(deps).accountKey === scope.accountKey;
    }
  }
  // Single live account: keep the original single-provider shape (and error
  // propagation) so a signed-out/not-configured state surfaces as before.
  if (managedAccounts.length === 0) {
    return includeLiveAccount ? fetchLiveCodexAccount(deps, nowMs) : [];
  }

  const providers = [];
  // Prefer the composite account key; use email only for legacy providers that
  // do not expose one. This keeps same-email workspaces distinct while still
  // collapsing the live and managed views of the exact same login.
  const seen = new Set();
  const identityKeys = (provider) => {
    if (provider.accountKey) return [`key:${provider.accountKey}`];
    return provider.accountEmail ? [`email:${provider.accountEmail}`] : [];
  };
  const markSeen = (provider) => { for (const key of identityKeys(provider)) seen.add(key); };
  const alreadySeen = (provider) => identityKeys(provider).some((key) => seen.has(key));
  // The live system account (the one the Codex app/CLI is currently signed into)
  // stays visible alongside managed accounts — adding a managed account never
  // hides the login you are actually using. Best-effort: a signed-out/Keychain-
  // only live account just drops out, leaving the managed accounts.
  if (includeLiveAccount) {
    try {
      const live = await fetchLiveCodexAccount(deps, nowMs, managedAccounts);
      providers.push(live);
      markSeen(live);
    } catch (_) {}
  }
  for (const account of managedAccounts) {
    const provider = await fetchManagedCodexAccountLimits(account, options, deps);
    if (alreadySeen(provider)) continue;
    providers.push(provider);
    markSeen(provider);
  }
  return providers;
}

async function fetchAntigravityLimits(_options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const updatedAt = nowIso(nowMs);
  const probeFn = deps.antigravityProbe || antigravityProbe.probe;
  try {
    const snapshot = await probeFn(deps);
    const accountLabel = snapshot.accountPlan ? antigravityPlanLabelFromParts(snapshot.accountPlan) : '';
    const accountKeySeed = snapshot.accountEmail || snapshot.accountPlan || 'default';
    const windows = Array.isArray(snapshot.windows)
      ? snapshot.windows.map((window) => ({
          kind: window.kind,
          label: window.name,
          usedPercent: typeof window.remainingFraction === 'number'
            ? Math.max(0, Math.min(100, (1 - window.remainingFraction) * 100))
            : null,
          resetsAt: window.resetTime || null,
          resetDescription: window.resetDescription || '',
          windowMinutes: window.kind === 'session' ? 300 : window.kind === 'weekly' ? 10_080 : null,
          showMeter: window.showMeter !== false
        }))
      : (snapshot.pools || []).map((pool) => ({
          kind: 'weekly',
          label: pool.name,
          usedPercent: Math.max(0, Math.min(100, (1 - pool.remainingFraction) * 100)),
          resetsAt: pool.resetTime || null,
          windowMinutes: null
        }));
    return normalizeLimitProvider({
      provider: 'antigravity',
      accountKey: hashKey('antigravity', accountKeySeed),
      accountLabel,
      accountEmail: snapshot.accountEmail || '',
      source: 'rpc',
      sourceDetail: snapshot.sourceDetail || '',
      status: 'ok',
      updatedAt,
      windows
    });
  } catch (err) {
    return normalizeLimitProvider({
      provider: 'antigravity',
      accountKey: '',
      accountLabel: '',
      source: 'rpc',
      status: providerStatusFromError(err),
      updatedAt,
      windows: []
    });
  }
}

function openCodeWebIdentity(goWeb, zen, cookie) {
  const goWorkspaceId = goWeb?.status === 'ok' ? String(goWeb.workspaceId || '') : '';
  const zenWorkspaceId = zen?.status === 'ok' ? String(zen.workspaceId || '') : '';
  const workspaceConflict = Boolean(
    goWorkspaceId && zenWorkspaceId && goWorkspaceId !== zenWorkspaceId
  );
  const includeZen = zen?.status === 'ok' && !workspaceConflict;
  const hasSuccessfulWebProbe = goWeb?.status === 'ok' || includeZen;
  // Go is the quota authority when two successful probes unexpectedly resolve
  // different workspaces. Exclude the Zen observation instead of attaching its
  // balance/windows to the wrong account identity.
  const workspaceId = goWorkspaceId || (includeZen ? zenWorkspaceId : '');
  if (hasSuccessfulWebProbe && workspaceId) {
    return {
      accountKey: hashKey('opencode', `workspace:${workspaceId}`),
      aliases: [
        hashKey('opencode', `go:${workspaceId}`),
        hashKey('opencode', `zen:${workspaceId}`)
      ],
      includeZen
    };
  }
  if (cookie && hasSuccessfulWebProbe) {
    const cookieHash = crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 12);
    return { accountKey: hashKey('opencode', `cookie:${cookieHash}`), aliases: [], includeZen };
  }
  return { accountKey: '', aliases: [], includeZen };
}

const OPENCODE_COMPONENT_PROVENANCE_DETAIL = 'managed';

// Statuses that mean "this source failed and the user should see it". Everything
// else, notably `notConfigured`, is a fall-through: the source simply has nothing
// for this account, so a later source may still answer.
const OPENCODE_REMOTE_FAIL_STATUSES = ['unauthorized', 'sourceRateLimited', 'unavailable'];

// Name for the account behind the key OpenCode stores for itself. Parallel to
// the existing 'default (env)' entry: not a user-chosen name, so it cannot be
// mistaken for a saved account, and stable so the row keeps its identity.
// Shown as the account's name until the user gives it one, so it has to survive
// `normalizeAccountName` intact — the previous "default (auto)" lost its
// brackets there and reached the card as "default auto". Canonical English on
// the wire, because a device record is read by devices in other locales; the
// renderer localizes this exact string.
const OPENCODE_AMBIENT_ACCOUNT_NAME = 'Auto-detected';

// Supplemental windows fill kinds the Go source did not answer, and are dropped
// for any kind it did. The comparison is against the windows actually taken
// rather than against one candidate source: Go quota resolves api → web → local,
// so naming a single source there leaves the other two unguarded and the account
// reports one window kind twice, from two sources and with two different numbers.
function openCodeSupplementalZenWindows(takenWindows, zen) {
  const takenKeys = new Set(
    (Array.isArray(takenWindows) ? takenWindows : [])
      .map(openCodeWindowKey)
      .filter(Boolean)
  );
  return (zen?.windows || []).filter((window) => {
    const key = openCodeWindowKey(window);
    return !key || !takenKeys.has(key);
  });
}

async function fetchOpenCodeLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const updatedAt = nowIso(nowMs);
  const collectGo = deps.opencodeCollectGo || ((d) => opencodeLimits.collectGo(d));
  const collectGoApi = deps.opencodeCollectGoApi || ((d) => opencodeGoApi.collectGoApi(d));
  const readGoApiKey = deps.opencodeReadGoApiKey || ((env) => opencodeGoApi.readGoApiKey(env));
  const fetchGoWeb = deps.opencodeFetchGoWeb || ((cookie, d) => opencodeWeb.fetchGoWeb(cookie, d));
  const fetchZen = deps.opencodeFetchZen || ((cookie, d) => opencodeWeb.fetchZen(cookie, d));

  // Determine cookie sources: explicit profiles > legacy single cookie > env var
  const explicitProfiles = options.opencodeProfiles;
  const envCookie = (deps.env || process.env).TOKEN_MONITOR_OPENCODE_COOKIE || '';

  // An account is a name, and credentials belong to a name. A profile may hold
  // any of: a cookie (Go quota plus Zen balance), a stored API key (Go quota),
  // or a reference to the key OpenCode keeps in auth.json. Sharing a name is
  // the user's own assertion that they are one account, which is the only thing
  // that licenses reading quota from one credential while identity and balance
  // come from another. The reference is stored rather than the key itself, so the
  // key is re-read every tick; it resolves only while it is still the key the
  // reference was bound to.
  const ambientKey = readGoApiKey(deps.env || process.env);
  const ambientIdentity = ambientKey ? opencodeGoApi.goApiIdentity(ambientKey) : '';
  const ambientFor = (p) => opencodeProfiles.ambientKeyFor(p, ambientKey, ambientIdentity);
  let cookies = [];
  if (explicitProfiles && Object.keys(explicitProfiles).length > 0) {
    for (const [name, p] of Object.entries(explicitProfiles)) {
      if (!p.enabled) continue;
      const apiKey = p.apiKey || ambientFor(p);
      if (apiKey || p.cookie) cookies.push({ name, apiKey, cookie: p.cookie });
    }
  } else if (options.opencodeCookie) {
    cookies = [{ name: 'default', cookie: options.opencodeCookie }];
  }

  // Env var — show only if its cookie isn't already in a profile
  if (envCookie && !cookies.some((c) => c.cookie === envCookie)) {
    cookies.push({ name: 'default (env)', cookie: envCookie });
  }

  // The auto-detected key is an unnamed credential until someone names it, so it
  // is tracked on its own and the zero-config path never disappears. Ownership is
  // the shared predicate rather than a copy of it here, so the settings panel
  // cannot end up offering a row this scan is not reading.
  const ambientClaimed = opencodeProfiles.ambientKeyClaimed(explicitProfiles, ambientKey, ambientIdentity);
  // Switched off for a machine signed in to an account the user does not want
  // reported. Only the unclaimed row is suppressed: once an account has claimed
  // the key it is that account's credential, and the account's own toggle owns
  // it, exactly as for a cookie.
  if (ambientKey && !ambientClaimed && options.opencodeAmbientEnabled !== false) {
    cookies.push({ name: OPENCODE_AMBIENT_ACCOUNT_NAME, apiKey: ambientKey, ambient: true });
  }

  const multiAccountMode = cookies.length > 1;
  const scope = options.limitRefreshScope?.provider === 'opencode'
    ? options.limitRefreshScope
    : null;
  if (scope && multiAccountMode) {
    const profileName = scope.accountName || scope.accountLabel;
    // Every scope originates from an action on a *stored* account, and the
    // auto-detected entry is by definition not one. Excluding it by that fact
    // rather than by its name keeps a user who happens to name an account the
    // same string from scoping a refresh onto both.
    cookies = profileName
      ? cookies.filter(({ name, ambient }) => !ambient && name === profileName)
      : [];
  }

  // ── Single account (0 or 1 cookie): existing merged behavior ─────────────
  if (!multiAccountMode) {
    // The database is device-wide and has no stable account identity, so every
    // caller must opt in explicitly before this process reads it.
    const goLocal = options.opencodeLocalLimitsEnabled === true
      ? collectGo({ env: deps.env || process.env, now: () => nowMs })
      : { status: 'notConfigured', windows: [] };
    const primary = cookies[0] || {};
    const cookie = primary.cookie;
    // Only this entry's own key, never the ambient one as a stand-in. The
    // ambient key is its own entry above; reaching for it here would pair it
    // with a cookie whose account nothing can prove it shares, and the cookie's
    // workspace identity wins below, so the result would publish one account's
    // quota — and merge it across devices — under the other's identity.
    const primaryApiKey = primary.apiKey || '';
    const [goApi, goWeb, zen] = await Promise.all([
      collectGoApi({
        env: deps.env || process.env,
        now: () => nowMs,
        fetch: deps.fetch,
        signal: deps.signal,
        apiKey: primaryApiKey
      }),
      cookie ? fetchGoWeb(cookie, { now: () => nowMs, fetch: deps.fetch }) : null,
      cookie ? fetchZen(cookie, { now: () => nowMs, workspaceId: '', fetch: deps.fetch }) : null
    ]);
    const webIdentity = openCodeWebIdentity(goWeb, zen, cookie);
    const webAccountKey = webIdentity.accountKey;

    const windows = [];
    let status = 'notConfigured';
    let source = 'local';
    let accountLabel = '';
    let accountKey = '';
    let balanceUsd = null;

    // Go quota resolves api → web → local. The official API needs no user setup
    // and is the only source anchored on the real subscription month, so it
    // outranks the cookie scrape; the local estimate stays last because it sees
    // only this device's rows and under-reports whenever the same account is
    // used elsewhere.
    //
    // API windows are tagged `web`, not `api`: windows[].source is a two-value
    // wire enum ('web' | 'local') that hubs rank on, and a hub that predates
    // this change would strip an unknown value and then rank the window *below*
    // a local estimate. Both values mean the same thing here anyway — server
    // truth from opencode.ai — and the finer provenance rides on the
    // provider-level source below.
    if (goApi.status === 'ok' && goApi.windows.length > 0) {
      windows.push(...goApi.windows.map((window) => ({ ...window, source: 'web' })));
      status = 'ok'; source = 'api'; accountLabel = 'Go';
      accountKey = hashKey('opencode', goApi.identity || 'go-api');
    } else if (goWeb && goWeb.status === 'ok' && goWeb.windows.length > 0) {
      windows.push(...goWeb.windows.map((window) => ({ ...window, source: 'web' })));
      status = 'ok'; source = 'web'; accountLabel = 'Go';
      accountKey = hashKey('opencode', `go:${goWeb.workspaceId || ''}`);
    } else if (goLocal.status === 'ok' && goApi.entitled !== false) {
      // `entitled === false` is the server saying this account has no Go plan,
      // which the local estimate cannot know: it would keep deriving quota from
      // rows a cancelled subscription left behind. Only an absent or failed API
      // answer leaves room for the estimate.
      windows.push(...goLocal.windows.map((window) => ({ ...window, source: 'local' })));
      status = 'ok'; accountLabel = 'Go';
      accountKey = hashKey('opencode', goLocal.identity || 'go');
    } else if (goLocal.status === 'unavailable' && goApi.entitled !== false) {
      status = 'unavailable';
    }

    if (zen && webIdentity.includeZen) {
      const supplemental = openCodeSupplementalZenWindows(windows, zen)
        .map((window) => ({ ...window, source: 'web' }));
      windows.push(...supplemental);
      status = 'ok';
      // The provider-level source is the compatibility envelope used by Hubs
      // that predate windows[].source. It may claim Web only when every quota
      // window is Web; otherwise an old Hub could turn a local estimate into a
      // Web observation when it strips component provenance.
      // 'api' already implies every quota window is server truth, so it keeps
      // that stronger claim instead of being flattened to 'web' by a Zen window.
      if (source !== 'api' && !windows.some((window) => window.source === 'local')) source = 'web';
      if (typeof zen.balanceUsd === 'number' && Number.isFinite(zen.balanceUsd)) balanceUsd = zen.balanceUsd;
      if (!accountLabel) accountLabel = 'Zen';
      if (!accountKey) accountKey = hashKey('opencode', `zen:${zen.workspaceId || ''}`);
    } else if (status !== 'ok') {
      const remoteFail = OPENCODE_REMOTE_FAIL_STATUSES;
      // Only reached when nothing produced windows. A stale API key would
      // otherwise read as "not configured" and leave the user nothing to fix.
      const surfaced = (remoteFail.includes(goApi.status) && { status: goApi.status, source: 'api' })
        || (goWeb && remoteFail.includes(goWeb.status) && { status: goWeb.status, source: 'web' })
        || (zen && remoteFail.includes(zen.status) && { status: zen.status, source: 'web' });
      if (surfaced) { status = surfaced.status; source = surfaced.source; }
    }

    // A failed API probe still names its account: the key identifies it, so a
    // 401 or a rate limit must not leave an empty accountKey that matches
    // nothing already stored on the Hub.
    if (!accountKey && goApi.identity) accountKey = hashKey('opencode', goApi.identity);
    if (webAccountKey) accountKey = webAccountKey;
    // Publish the key's own identity as an alias whenever one was used. The
    // cookie's workspace identity wins above, so without this a device holding
    // only the key would never group with the account it belongs to.
    const apiAlias = goApi.identity ? hashKey('opencode', goApi.identity) : '';
    return normalizeLimitProvider({
      provider: 'opencode',
      // The account this row is for, whether or not more than one exists. Left
      // off, a machine that resolves to exactly one OpenCode account showed it
      // as "Account 1", and enabling a second account did not fix it until a
      // restart: the scoped refresh only rebuilds the account it targets, so
      // this row kept its nameless record while the new one arrived named.
      accountName: primary.name || '',
      accountKey,
      webAccountKey,
      accountKeyAliases: [...webIdentity.aliases, apiAlias].filter(Boolean),
      accountLabel,
      source,
      sourceDetail: OPENCODE_COMPONENT_PROVENANCE_DETAIL,
      status,
      updatedAt,
      windows,
      balanceUsd
    });
  }

  // ── Multi-account (2+ cookies): separate per-profile providers ────────────
  const providers = [];

  // Each enabled profile — query in parallel. One path for every credential
  // combination: an account holding only a key is the same shape with no cookie,
  // and keeping it as a separate function is what let the two drift apart.
  const results = await Promise.all(
    cookies.map((profile) => fetchOpenCodeProfile(
      profile.name,
      profile.cookie,
      fetchGoWeb,
      fetchZen,
      nowMs,
      updatedAt,
      { apiKey: profile.apiKey, collectGoApi, deps }
    ))
  );
  for (const provider of results) {
    if (provider) providers.push(provider);
  }

  if (providers.length === 0) {
    providers.push(normalizeLimitProvider({
      provider: 'opencode', accountKey: '', accountLabel: '',
      source: 'local', status: 'notConfigured', updatedAt, windows: []
    }));
  }

  return providers;
}

// One account, whichever credentials it holds. `cookie` and `api.apiKey` are
// each optional: sharing a name is the user's assertion that they are the same
// account, which is what licenses reading Go quota from the key while Zen
// balance and the workspace identity come from the cookie. An account holding
// only one of them is the same shape with the other absent.
async function fetchOpenCodeProfile(name, cookie, fetchGoWeb, fetchZen, nowMs, updatedAt, api = {}) {
  const PROFILE_TIMEOUT_MS = 15000;
  let timer;

  try {
    const result = await Promise.race([
      (async () => {
        const [goWeb, zen, goApi] = await Promise.all([
          cookie ? fetchGoWeb(cookie, { now: () => nowMs, fetch: api.deps?.fetch }) : null,
          cookie ? fetchZen(cookie, { now: () => nowMs, workspaceId: '', fetch: api.deps?.fetch }) : null,
          api.apiKey
            ? api.collectGoApi({
              env: api.deps?.env || process.env,
              now: () => nowMs,
              fetch: api.deps?.fetch,
              signal: api.deps?.signal,
              apiKey: api.apiKey
            })
            : null
        ]);
        return { goWeb, zen, goApi };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), PROFILE_TIMEOUT_MS);
      })
    ]);
    clearTimeout(timer);

    const { goWeb, zen, goApi } = result;
    const windows = [];
    let status = 'notConfigured';
    let planLabel = '';
    let balanceUsd = null;
    let source = 'web';

    if (goApi && goApi.status === 'ok' && goApi.windows.length > 0) {
      windows.push(...goApi.windows.map((window) => ({ ...window, source: 'web' })));
      status = 'ok';
      planLabel = 'Go';
      source = 'api';
    } else if (goWeb && goWeb.status === 'ok' && goWeb.windows.length > 0) {
      windows.push(...goWeb.windows.map((window) => ({ ...window, source: 'web' })));
      status = 'ok';
      planLabel = 'Go';
    }

    const webIdentity = openCodeWebIdentity(goWeb, zen, cookie);
    if (zen && webIdentity.includeZen) {
      const supplemental = openCodeSupplementalZenWindows(windows, zen)
        .map((window) => ({ ...window, source: 'web' }));
      windows.push(...supplemental);
      status = 'ok';
      if (!planLabel) planLabel = 'Zen';
      if (typeof zen.balanceUsd === 'number' && Number.isFinite(zen.balanceUsd)) balanceUsd = zen.balanceUsd;
    }

    if (status !== 'ok') {
      // `notConfigured` from the API means "this account has no Go subscription",
      // which is a fallback condition rather than a failure. Letting it win here
      // would hide the cookie's own `unauthorized` and tell the user nothing is
      // configured when what actually happened is that their cookie expired.
      // The API's own `notConfigured` is ranked last rather than dropped: it
      // must not outrank an expired cookie, but on an account with no cookie at
      // all it is the true answer, and falling through to the literal would
      // report "sign in again" for a workspace that simply has no Go plan.
      //
      // Provenance travels with the status, as it does on the single-account
      // path and in the timeout branch below. Left behind, the `web` default
      // stood while the status came from the key, so one expired API key read
      // as an `API` failure on a machine with a single account and as a `Web`
      // failure the moment a second account existed. How many accounts are
      // configured cannot change which credential failed.
      const failure = (OPENCODE_REMOTE_FAIL_STATUSES.includes(goApi?.status) && { status: goApi.status, source: 'api' })
        || (goWeb && { status: goWeb.status, source: 'web' })
        || (zen && { status: zen.status, source: 'web' })
        || (goApi && { status: goApi.status, source: 'api' })
        || { status: 'unauthorized', source: api.apiKey && !cookie ? 'api' : 'web' };
      status = failure.status;
      source = failure.source;
    }

    // The key's own identity, published whenever this account holds one. The
    // same key on another device that has no cookie identifies itself by that
    // key alone, so without this the two devices never group into one account.
    const keyIdentity = api.apiKey
      ? hashKey('opencode', opencodeGoApi.goApiIdentity(api.apiKey))
      : '';

    // Stable accountKey derived from workspaceId (preferred), then the key, then
    // the cookie hash — never from the user-editable profile name, so the same
    // account is identified consistently across machines and renames. The key
    // ranks above the cookie hash because it is the same string on every device,
    // while a cookie is per-browser-session.
    let accountKey = webIdentity.accountKey || keyIdentity;
    if (!accountKey && cookie) {
      const cookieHash = crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 12);
      accountKey = hashKey('opencode', `cookie:${cookieHash}`);
    }
    const boundKeyAlias = accountKey === keyIdentity ? '' : keyIdentity;

    return normalizeLimitProvider({
      provider: 'opencode',
      accountKey,
      // Only a cookie yields this. The Hub picks the canonical identity for a
      // merged account from the webAccountKeys it collects, and it picks by
      // sorting them, so publishing the key's hash here would let an API-only
      // device's identity win over a real workspace id — deciding an account's
      // canonical identity by which devices happen to be online.
      webAccountKey: webIdentity.accountKey,
      accountKeyAliases: [...webIdentity.aliases, boundKeyAlias].filter(Boolean),
      accountName: name,
      // Keep accountLabel as the profile name for pre-accountName renderers.
      // New renderers use planLabel for Go/Zen and accountName for identity.
      accountLabel: name,
      planLabel,
      source,
      sourceDetail: OPENCODE_COMPONENT_PROVENANCE_DETAIL,
      status,
      updatedAt,
      windows,
      balanceUsd
    });
  } catch (error) {
    clearTimeout(timer);
    // Routing the API probe through this helper made it reachable by an abort,
    // which the bare catch would have turned into a stale `unavailable` row and
    // published over whatever superseded it. The lane is latest-wins.
    if (opencodeGoApi.isAbortError(error, api.deps?.signal)) throw error;
    // Same identity ranking as the success path, so a timeout does not hand the
    // account a different accountKey than the one already on the Hub.
    let accountKey = api.apiKey ? hashKey('opencode', opencodeGoApi.goApiIdentity(api.apiKey)) : '';
    if (!accountKey && cookie) {
      const cookieHash = crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 12);
      accountKey = hashKey('opencode', `cookie:${cookieHash}`);
    }
    return normalizeLimitProvider({
      // No webAccountKey: this row probed nothing, so it has no workspace
      // identity to offer, and claiming one would let a timed-out device decide
      // the canonical identity of the merged account.
      provider: 'opencode', accountKey,
      accountName: name, accountLabel: name, planLabel: '',
      source: api.apiKey && !cookie ? 'api' : 'web',
      sourceDetail: OPENCODE_COMPONENT_PROVENANCE_DETAIL, status: 'unavailable',
      updatedAt, windows: [], balanceUsd: null
    });
  }
}

function providerStatusFromError(error) {
  if (['disabled', 'notConfigured', 'unauthorized', 'rateLimited', 'sourceRateLimited', 'unavailable', 'error'].includes(error?.status)) return error.status;
  if (error?.code === 'ENOENT') return 'notConfigured';
  return 'unavailable';
}

function statusProvider(provider, status, updatedAt) {
  return normalizeLimitProvider({ provider, status, updatedAt, windows: [] });
}

function cleanSecret(value) {
  let raw = value;
  if (typeof raw !== 'string') return '';
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function deepseekToken(env = process.env, explicitKey = '') {
  const explicit = cleanSecret(explicitKey);
  if (explicit) return explicit;
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY']) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

// rows: balance_infos from /user/balance. Returns { currency, amount(total), paid(topped_up) }.
function selectFundedRow(rows) {
  const parsed = [];
  for (const row of rows || []) {
    const amount = Number(row && row.total_balance);
    const paid = Number(row && row.topped_up_balance);
    const currency = String((row && row.currency) || '').trim().toUpperCase();
    if (!Number.isFinite(amount) || !Number.isFinite(paid) || !currency) continue;
    parsed.push({ currency, amount, paid });
  }
  if (parsed.length === 0) throw errorWithStatus('unavailable', 'no usable balance rows');
  const funded = parsed
    .filter((r) => r.amount > 0)
    .sort((a, b) => (b.amount - a.amount) || (a.currency === 'USD' ? -1 : b.currency === 'USD' ? 1 : 0));
  if (funded.length) return funded[0];
  return parsed.find((r) => r.currency === 'USD') || parsed[0];
}

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

async function fetchDeepSeekLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const key = deepseekToken(env, options.deepseekApiKey);
  if (!key) {
    return normalizeLimitProvider({ provider: 'deepseek', source: 'api', status: 'notConfigured', updatedAt: nowIso(now), windows: [] });
  }
  try {
    const data = await fetchJson(DEEPSEEK_BALANCE_URL, { Authorization: `Bearer ${key}`, Accept: 'application/json' }, deps);
    if (!data || !Array.isArray(data.balance_infos)) {
      throw errorWithStatus('unavailable', 'unexpected balance response shape');
    }
    const row = selectFundedRow(data.balance_infos);
    const accountKey = hashKey('deepseek', key);
    const dataDir = sharedDataDir({ env });
    const storePath = deps.deepseekStorePath || path.join(dataDir, 'deepseek-balance-v2.json');
    const legacyStorePath = deps.deepseekLegacyStorePath
      || (deps.deepseekStorePath ? null : path.join(dataDir, 'deepseek-balance.json'));
    const spend = recordConsumption(
      { accountKey, currency: row.currency, paid: row.paid, now, storePath, legacyStorePath },
      deps
    );
    return normalizeLimitProvider({
      provider: 'deepseek',
      accountKey,
      accountLabel: 'Pay-as-you-go',
      source: 'api',
      status: 'ok',
      updatedAt: nowIso(now),
      // DeepSeek has no rate-limit windows. The balance is the only quota it
      // exposes, so it ships as a credits window: money, no wire percentage.
      windows: [{
        kind: 'billing',
        metric: 'credits',
        label: 'Balance',
        remaining: row.amount,
        currency: row.currency
      }],
      balance: {
        amount: row.amount,
        currency: row.currency,
        todaySpend: spend.todaySpend,
        weekSpend: spend.weekSpend,
        monthSpend: spend.monthSpend,
        allTimeSpend: spend.allTimeSpend,
        trackingSince: spend.trackingSince,
        monthSinceTracking: spend.monthSinceTracking
      }
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'deepseek',
      source: 'api',
      status: providerStatusFromError(error),
      updatedAt: nowIso(now),
      windows: []
    });
  }
}

function providerFetchers(deps = {}) {
  return {
    claude: (providerOptions, probeDeps) => fetchClaudeLimits(providerOptions, probeDeps),
    codex: (providerOptions, probeDeps) => fetchCodexLimits(providerOptions, probeDeps),
    cursor: (providerOptions, probeDeps) => fetchCursorLimits(providerOptions, probeDeps),
    antigravity: (providerOptions, probeDeps) => fetchAntigravityLimits(providerOptions, probeDeps),
    opencode: (providerOptions, probeDeps) => fetchOpenCodeLimits(providerOptions, probeDeps),
    openrouter: (providerOptions, probeDeps) => openrouterLimits.fetchOpenRouterLimits(providerOptions, probeDeps),
    deepseek: (providerOptions, probeDeps) => fetchDeepSeekLimits(providerOptions, probeDeps),
    minimax: (providerOptions, probeDeps) => minimaxLimits.fetchMinimaxLimits(providerOptions, probeDeps),
    mimo: (providerOptions, probeDeps) => fetchMimoLimits(providerOptions, probeDeps),
    grok: (providerOptions, probeDeps) => grokLimits.fetchGrokLimits(providerOptions, probeDeps),
    copilot: (providerOptions, probeDeps) => copilotLimits.fetchCopilotLimits(providerOptions, probeDeps),
    kiro: (providerOptions, probeDeps) => kiroLimits.fetchKiroLimits(providerOptions, probeDeps),
    zai: (providerOptions, probeDeps) => zaiLimits.fetchZaiLimits(providerOptions, probeDeps),
    zaiteam: (providerOptions, probeDeps) => zaiTeamLimits.fetchZaiTeamLimits(providerOptions, probeDeps),
    volcengine: (providerOptions, probeDeps) => volcengineLimits.fetchVolcengineLimits(providerOptions, probeDeps),
    commandcode: (providerOptions, probeDeps) => commandcodeLimits.fetchCommandcodeLimits(providerOptions, probeDeps),
    qoder: (providerOptions, probeDeps) => qoderLimits.fetchQoderLimits(providerOptions, probeDeps),
    ollama: (providerOptions, probeDeps) => ollamaLimits.fetchOllamaLimits(providerOptions, probeDeps),
    kimi: (providerOptions, probeDeps) => kimiLimits.fetchKimiLimits(providerOptions, probeDeps),
    thirdparty: (providerOptions, probeDeps) => thirdPartyLimits.fetchThirdPartyLimits(providerOptions, probeDeps),
    ...(deps.providerFetchers || {})
  };
}

function providerPhysicalBoundMs(provider, options = {}, deps = {}) {
  const configured = Number(deps.providerPhysicalBounds?.[provider]);
  const base = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_PROVIDER_PHYSICAL_BOUND_MS;
  let jobs = 1;
  if (provider === 'codex') {
    const managed = normalizeCodexManagedAccounts(options.codexManagedAccounts || deps.codexManagedAccounts);
    jobs = options.limitRefreshScope?.provider === 'codex' && [
      'accountKey',
      'accountId',
      'managedAccountId',
      'id',
      'accountEmail',
      'email',
      'accountName',
      'name',
      'accountLabel'
    ].some((key) => String(options.limitRefreshScope[key] || '').trim())
      ? 1
      : Math.max(1, managed.length + 1);
  } else if (provider === 'mimo') {
    const managed = Array.isArray(options.mimoManagedAccounts || deps.mimoManagedAccounts)
      ? (options.mimoManagedAccounts || deps.mimoManagedAccounts)
      : [];
    jobs = options.limitRefreshScope?.provider === 'mimo' ? 1 : Math.max(1, managed.length);
  }
  return base * jobs;
}

function createProbeFetch(fetchFn, context = {}, deps = {}) {
  return async (url, init = {}) => {
    const signals = [context.signal, init.signal].filter(Boolean);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const response = await fetchFn(url, {
      ...init,
      ...(signal ? { signal } : {})
    });
    if (Number(response?.status) >= 400) {
      const retryAfterMs = parseRetryAfterHeader(
        response?.headers?.get?.('retry-after'),
        (deps.now || Date.now)()
      );
      if (retryAfterMs !== null) context.onRetryAfter?.(retryAfterMs);
    }
    return response;
  };
}

function resolveProviderFetch(provider, deps = {}) {
  if (typeof deps.fetch === 'function') return deps.fetch;
  if (provider === 'grok') return grokLimits.resolveGrokFetch(deps);
  return fetch;
}

async function probeLimitProvider(provider, options = {}, context = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const fetcher = providerFetchers(deps)[provider];
  if (!fetcher) return [statusProvider(provider, 'notConfigured', nowIso(nowMs))];
  try {
    const signal = context.signal ?? deps.signal;
    const result = await fetcher(options, {
      ...deps,
      fetch: createProbeFetch(resolveProviderFetch(provider, deps), { ...context, signal }, deps),
      signal
    });
    return (Array.isArray(result) ? result : [result]).filter(Boolean);
  } catch (error) {
    return [statusProvider(provider, providerStatusFromError(error), nowIso(nowMs))];
  }
}

async function collectLimitsOnce(options = {}, deps = {}) {
  const enabled = parseBoolean(options.limitsEnabled ?? options.enabled, true);
  const refreshMs = normalizeLimitsRefreshMs(options.limitsRefreshMs ?? options.refreshMs);
  const nowMs = (deps.now || Date.now)();
  if (!enabled) return normalizeLimitsSummary({ updatedAt: nowIso(nowMs), refreshMs, providers: [] });

  const providers = [];
  const scope = options.limitRefreshScope;
  const selectedProviders = parseLimitProviders(options.limitProviders ?? options.providers)
    .filter((provider) => !scope?.provider || provider === scope.provider);
  for (const provider of selectedProviders) {
    providers.push(...await probeLimitProvider(provider, options, {}, deps));
  }
  return normalizeLimitsSummary({ updatedAt: nowIso(nowMs), refreshMs, providers });
}

// Compatibility facade for internal callers that still use the former
// snapshot/refreshScope API. All ordering, identity, retention, and deadline
// semantics are owned by LimitsRuntime; this facade only retains the former
// full-snapshot TTL and has no in-flight coordination of its own.
function createLimitsCollector(options = {}, deps = {}) {
  const { createLimitsRuntime } = require('./limitsRuntime');
  const runtime = createLimitsRuntime(options, { ...deps, autoStart: false, autoRetry: false });
  const refreshMs = normalizeLimitsRefreshMs(options.limitsRefreshMs ?? options.refreshMs);
  const now = deps.now || Date.now;
  let lastFullRefreshAt = null;
  const refreshedSnapshot = async (scope, reason) => {
    const result = await runtime.refresh(scope, reason);
    return result?.snapshot || (result?.providers ? result : runtime.getSnapshot());
  };
  const refreshedFullSnapshot = async (reason) => {
    const result = await refreshedSnapshot({}, reason);
    lastFullRefreshAt = now();
    return result;
  };
  return {
    refreshScope: (scope) => refreshedSnapshot(scope, 'compat-scoped'),
    snapshot: (force = false) => {
      const stale = lastFullRefreshAt === null || now() - lastFullRefreshAt >= refreshMs;
      return force || stale
        ? refreshedFullSnapshot(force ? 'compat-full' : 'compat-stale')
        : Promise.resolve(runtime.getSnapshot());
    },
    stop: () => runtime.stop()
  };
}

function hashCursorAccountKey(account) {
  const seed = account.userId || account.id || 'cursor';
  return hashKey('cursor', seed);
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

async function fetchCursorLimits(_options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const updatedAt = new Date(nowMs).toISOString();
  const readActiveAccount = deps.readActiveAccount || cursorAuth.readActiveAccount;
  const probe = deps.probe || cursorProbe.probe;

  const account = readActiveAccount();
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
  const totalPercent = hasRequestUsage
    ? percentFromUsedLimit(usage.requestsUsed, usage.requestsLimit)
    : usage.planPercent;
  const windows = [
    cursorBillingWindow('Total', {
      usedPercent: totalPercent,
      used: hasRequestUsage ? usage.requestsUsed : usage.planUsedUsd,
      limit: hasRequestUsage ? usage.requestsLimit : usage.planLimitUsd,
      remaining: hasRequestUsage
        ? Math.max(0, usage.requestsLimit - usage.requestsUsed)
        : usage.planRemainingUsd,
      resetsAt,
      windowMinutes: null,
      resetDescription: usage.membershipType ? `Cursor ${usage.membershipType}` : ''
    })
  ];

  if (finiteNumber(usage.autoPercent) !== null) {
    windows.push(cursorBillingWindow('Auto', {
      usedPercent: usage.autoPercent,
      resetsAt,
      windowMinutes: null
    }));
  }

  if (finiteNumber(usage.apiPercent) !== null) {
    windows.push(cursorBillingWindow('API', {
      usedPercent: usage.apiPercent,
      resetsAt,
      windowMinutes: null
    }));
  }

  if (usage.hasOnDemandUsage || finiteNumber(usage.onDemandLimitUsd) !== null || (finiteNumber(usage.onDemandUsedUsd) !== null && usage.onDemandUsedUsd > 0)) {
    const remaining = finiteNumber(usage.onDemandRemainingUsd)
      ?? (finiteNumber(usage.onDemandLimitUsd) !== null
        ? Math.max(0, usage.onDemandLimitUsd - (finiteNumber(usage.onDemandUsedUsd) || 0))
        : null);
    windows.push(cursorBillingWindow('Credits', {
      usedPercent: finiteNumber(usage.onDemandPercent) ?? percentFromUsedLimit(usage.onDemandUsedUsd, usage.onDemandLimitUsd),
      used: usage.onDemandUsedUsd,
      limit: usage.onDemandLimitUsd,
      remaining,
      resetsAt: null,
      windowMinutes: null,
      resetDescription: '',
      showMeter: false
    }));
  }

  if (usage.hasTeamOnDemandUsage || finiteNumber(usage.teamOnDemandLimitUsd) !== null || (finiteNumber(usage.teamOnDemandUsedUsd) !== null && usage.teamOnDemandUsedUsd > 0)) {
    const remaining = finiteNumber(usage.teamOnDemandRemainingUsd)
      ?? (finiteNumber(usage.teamOnDemandLimitUsd) !== null
        ? Math.max(0, usage.teamOnDemandLimitUsd - (finiteNumber(usage.teamOnDemandUsedUsd) || 0))
        : null);
    windows.push(cursorBillingWindow('Team credits', {
      usedPercent: finiteNumber(usage.teamOnDemandPercent) ?? percentFromUsedLimit(usage.teamOnDemandUsedUsd, usage.teamOnDemandLimitUsd),
      used: usage.teamOnDemandUsedUsd,
      limit: usage.teamOnDemandLimitUsd,
      remaining,
      resetsAt: null,
      windowMinutes: null,
      resetDescription: '',
      showMeter: false
    }));
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

  return {
    provider: 'cursor',
    accountKey: hashCursorAccountKey(account),
    accountLabel: formatCursorMembership(usage.membershipType) || account.label || '',
    status: 'ok',
    source: 'web',
    updatedAt,
    windows
  };
}

module.exports = {
  LIMIT_PROVIDER_IDS,
  DEFAULT_PROVIDER_PHYSICAL_BOUND_MS,
  PROVIDER_CLEANUP_GRACE_MS,
  collectLimitsOnce,
  claudeCommandCandidates,
  codexCommandCandidates,
  codexCommandSourceDetail,
  createProbeFetch,
  resolveProviderFetch,
  createLimitsCollector,
  probeLimitProvider,
  providerPhysicalBoundMs,
  fetchAntigravityLimits,
  fetchOpenCodeLimits,
  fetchOpenRouterLimits: openrouterLimits.fetchOpenRouterLimits,
  fetchThirdPartyLimits: thirdPartyLimits.fetchThirdPartyLimits,
  fetchOpenCodeProfile,
  claudeWebCookie,
  normalizeClaudeWebCookieInput,
  fetchClaudeLimits,
  fetchCodexLimits,
  fetchCursorLimits,
  fetchDeepSeekLimits,
  fetchMimoLimits,
  readCodexRpcWithCommand,
  runCodexLogin,
  runProcessText,
  deepseekToken,
  selectFundedRow,
  minimaxToken,
  minimaxBaseUrl,
  parseMinimaxTiers,
  fetchMinimaxLimits,
  grokCredential,
  readAuthJson,
  parseGrokBilling,
  parseGrokGrpcWebBilling,
  fetchGrokRpcBilling,
  fetchGrokWebGrpcBilling,
  fetchGrokLimits,
  copilotToken,
  fetchCopilotLimits,
  parseKiroUsage,
  fetchKiroLimits,
  zaiToken,
  zaiRegion,
  fetchZaiLimits,
  zaiTeamToken,
  fetchZaiTeamLimits,
  volcengineCredentials,
  fetchVolcengineLimits,
  qoderCookie,
  fetchQoderLimits,
  commandcodeCookie,
  fetchCommandcodeLimits,
  ollamaSessionCookie,
  fetchOllamaLimits,
  kimiToken,
  kimiWebToken,
  fetchKimiLimits,
  mapClaudeCliUsageToProvider,
  mapClaudeUsageToProvider,
  mapCodexRateLimitsToProvider,
  parseClaudeCliUsageText,
  parseBoolean,
  parseLimitProviders,
  normalizeLimitsRefreshMode,
  normalizeLimitsRefreshMs,
  refreshClaudeAccessToken,
  refreshClaudeCredentials,
  delegatedClaudeRefresh,
  touchClaudeAuthPath,
  rankClaudeCredentialFiles,
  wslClaudeCredentialPaths
};
