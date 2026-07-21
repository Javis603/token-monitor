'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appVersion } = require('./appVersion');
const {
  DEFAULT_LIMITS_REFRESH_MS,
  normalizeLimitProvider,
  normalizeLimitsSummary
} = require('./limits');
const cursorAuth = require('./cursorAuth');
const cursorProbe = require('./cursorProbe');
const antigravityProbe = require('./antigravityProbe');
const opencodeLimits = require('./opencodeLimits');
const opencodeWeb = require('./opencodeWeb');
const { sharedDataDir } = require('./config');
const { recordConsumption } = require('./deepseekBalanceHistory');
const { codexAuthIdentity } = require('./codexAuth');
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

const LIMIT_PROVIDER_IDS = ['claude', 'codex', 'cursor', 'antigravity', 'opencode', 'deepseek', 'minimax', 'mimo', 'grok', 'copilot', 'kiro', 'zai', 'volcengine', 'qoder', 'zaiteam', 'kimi', 'ollama'];
const DEFAULT_PROVIDER_PHYSICAL_BOUND_MS = 120_000;
const PROVIDER_CLEANUP_GRACE_MS = 5_000;
const LIMIT_REFRESH_VALUES = new Set([60_000, 120_000, 300_000, 900_000, 1_800_000]);
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
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

function planLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '')).find(Boolean) || '';
  const raw = cleanPlanText(text);
  if (!raw || raw.includes('@')) return '';
  const aliases = {
    free: 'Free',
    plus: 'Plus',
    pro: 'Pro',
    max: 'Max',
    team: 'Team',
    teams: 'Team',
    enterprise: 'Enterprise',
    ultra: 'Ultra'
  };
  if (aliases[raw]) return aliases[raw];
  return displayPlanText(raw);
}

function claudeRateLimitTierLabel(rateLimitTier) {
  const raw = cleanPlanText(rateLimitTier, []);
  if (!raw) return '';
  const words = raw.split(/\s+/).filter((word) => !['default', 'claude', 'ai'].includes(word));
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
  return new Promise((resolve, reject) => {
    const child = spawnFn('security', ['find-generic-password', '-s', service, '-w'], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('macOS keychain lookup timed out'));
    }, 5000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `security exited ${code}`));
      else resolve(stdout.trim());
    });
  });
}

function runProcessText(command, args = [], options = {}) {
  const spawnFn = options.spawn || spawn;
  const timeoutMs = Number(options.timeoutMs || 30000);
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: Boolean(options.shell),
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      reject(errorWithStatus('unavailable', `${command} timed out`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout);
      else reject(errorWithStatus('unavailable', stderr.trim() || `${command} exited ${code}`));
    });
  });
}

async function fetchJson(url, headers, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchFn(url, { headers, ...(controller ? { signal: controller.signal } : {}) });
    if (!response.ok) {
      const status = response.status === 401 ? 'unauthorized' : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw errorWithStatus(status, `${url} returned ${response.status}`);
    }
    return response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw errorWithStatus('unavailable', `${url} timed out`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  return normalizeLimitProvider({
    provider: 'claude',
    accountKey: meta.accountKey || '',
    accountLabel: meta.accountLabel || '',
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

async function fetchClaudeLimits(_options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const platform = deps.platform || process.platform;
  try {
    let credentials = await readClaudeCredentials(deps);

    // Proactive refresh only on non-darwin: mac uses delegated (spawning Claude Code)
    // which is expensive; CodexBar's design likewise refreshes reactively, not on expiry.
    if (platform !== 'darwin' && credentials.refreshToken && credentials.expiresAt
      && credentials.expiresAt - nowMs < CLAUDE_REFRESH_LEEWAY_MS) {
      try {
        credentials = await refreshClaudeCredentials(credentials, deps);
      } catch (_) { /* fall through; reactive retry below may still succeed */ }
    }

    let usage;
    try {
      usage = await callClaudeUsage(credentials.accessToken, deps);
    } catch (error) {
      if (error?.status !== 'unauthorized') throw error;
      credentials = await refreshClaudeCredentials(credentials, deps);
      usage = await callClaudeUsage(credentials.accessToken, deps);
    }

    const provider = mapClaudeUsageToProvider(usage, {
      accountKey: hashKey('claude', credentials.identity),
      accountLabel: credentials.accountLabel,
      updatedAt: nowIso(nowMs),
      source: 'oauth'
    });
    return provider;
  } catch (error) {
    if (!shouldTryClaudeCliFallback(error)) throw error;
    try {
      const text = await runClaudeUsageCli(deps);
      return mapClaudeCliUsageToProvider(text, {
        updatedAt: nowIso(nowMs),
        now: new Date(nowMs)
      });
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
  if (mins >= 7 * 24 * 60) return 'weekly';
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
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function mapCodexRateLimitsToProvider(payload, meta = {}) {
  const rateLimits = codexRateLimitSnapshot(payload);
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const window = rateLimits[key];
    if (!window) continue;
    windows.push({
      kind: codexWindowKind(key, window),
      usedPercent: window.usedPercent ?? window.used_percent,
      resetsAt: window.resetsAt ?? window.resets_at,
      windowMinutes: window.windowDurationMins ?? window.window_duration_mins
    });
  }
  return normalizeLimitProvider({
    provider: 'codex',
    accountKey: meta.accountKey || '',
    accountLabel: meta.accountLabel || codexAccountLabel(payload),
    accountEmail: meta.accountEmail || payload.account?.email || '',
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

function killCodexLoginProcess(child, platform = process.platform, deps = {}) {
  if (!child || typeof child.kill !== 'function') return;
  const spawnFn = deps.spawn || spawn;
  try {
    // Login spawns a browser/callback helper, so kill the whole tree, not just codex.
    if (platform === 'win32') {
      if (child.pid) {
        try { spawnFn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); } catch (_) {}
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
      killCodexLoginProcess(child, platform, { spawn: spawnFn });
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
      killCodexLoginProcess(child, platform, { spawn: spawnFn });
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
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
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

  return { send, notify, rejectAll };
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
  const child = spawnCodexAppServer({ ...deps, codexCommand: command });
  const rpc = createJsonRpcClient(child, timeoutMs);
  try {
    await rpc.send('initialize', {
      clientInfo: { name: 'token-monitor', title: 'Token Monitor', version: appVersion() }
    });
    rpc.notify('initialized', {});
    let rateLimitResult = await rpc.send('account/rateLimits/read');
    const accountResult = await rpc.send('account/read').catch(() => null);
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
      } catch (_) {}
    }
    if (!account && !hasCodexRateLimitWindows(codexRateLimitSnapshot(payload))) {
      throw errorWithStatus('notConfigured', 'Codex account not configured');
    }
    return payload;
  } finally {
    try { child.kill('SIGTERM'); } catch (_) {}
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
      enabled: account.enabled !== false
    };
  }).filter(Boolean);
}

function codexAccountKeyFromSeed(seed) {
  const raw = String(seed || '').trim();
  return raw.startsWith('sha256:') ? raw : hashKey('codex', raw || 'account');
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
  const accountKeySeed = account.accountKey || account.email || account.id || account.homePath;
  try {
    const payload = await withCodexOAuthResetCredits(await reader(accountDeps), accountDeps);
    const email = payload.account?.email || account.email;
    const identity = account.accountKey || email || account.id || account.homePath;
    return mapCodexRateLimitsToProvider(payload, {
      accountKey: codexAccountKeyFromSeed(identity),
      accountEmail: email,
      accountLabel: account.accountLabel || codexAccountLabel(payload),
      updatedAt: nowIso(nowMs),
      source: 'rpc',
      sourceDetail: 'managed'
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'codex',
      accountKey: codexAccountKeyFromSeed(accountKeySeed),
      accountEmail: account.email,
      accountLabel: account.accountLabel,
      source: 'rpc',
      sourceDetail: 'managed',
      status: providerStatusFromError(error),
      updatedAt: nowIso(nowMs),
      windows: []
    });
  }
}

// Reads the live login's identity (email + stable account id) from its
// auth.json. The RPC `account/read` often omits the email, so the JWT in
// auth.json is the reliable source — and keying on the account id keeps the
// live account consistent with managed accounts for cross-device dedup.
function readLiveCodexIdentity(deps = {}) {
  const read = deps.readFileSync || fs.readFileSync;
  const authPath = deps.codexAuthPath || codexAuthPath(deps.env || process.env);
  try {
    return codexAuthIdentity(JSON.parse(read(authPath, 'utf8')));
  } catch (_) {
    return { email: '', accountLabel: '', providerAccountId: '', accountKey: '' };
  }
}

async function fetchLiveCodexAccount(deps = {}, nowMs = Date.now()) {
  const reader = deps.readCodexRpc || readCodexRpc;
  const payload = await withCodexOAuthResetCredits(await reader(deps), deps);
  const authIdentity = readLiveCodexIdentity(deps);
  const email = authIdentity.email || payload.account?.email || '';
  const fallbackSeed = payload.account?.email || `${payload.account?.type || 'account'}:${payload.account?.planType || ''}:${deps.codexAuthPath || codexAuthPath(deps.env || process.env)}`;
  return mapCodexRateLimitsToProvider(payload, {
    accountKey: authIdentity.accountKey || hashKey('codex', fallbackSeed),
    accountEmail: email,
    accountLabel: codexAccountLabel(payload),
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
      const accountKey = codexAccountKeyFromSeed(account.accountKey || account.email || account.id || account.homePath);
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
  // Dedupe by account id (accountKey) first, then email — so signing in the
  // account that's already the live login shows ONE row, even if one side has
  // no email. Both paths key on the stable account id, so the same account
  // matches regardless of how it was added.
  const seen = new Set();
  const identityKeys = (provider) => [
    provider.accountKey ? `key:${provider.accountKey}` : '',
    provider.accountEmail ? `email:${provider.accountEmail}` : ''
  ].filter(Boolean);
  const markSeen = (provider) => { for (const key of identityKeys(provider)) seen.add(key); };
  const alreadySeen = (provider) => identityKeys(provider).some((key) => seen.has(key));
  // The live system account (the one the Codex app/CLI is currently signed into)
  // stays visible alongside managed accounts — adding a managed account never
  // hides the login you are actually using. Best-effort: a signed-out/Keychain-
  // only live account just drops out, leaving the managed accounts.
  if (includeLiveAccount) {
    try {
      const live = await fetchLiveCodexAccount(deps, nowMs);
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

async function fetchOpenCodeLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const updatedAt = nowIso(nowMs);
  const collectGo = deps.opencodeCollectGo || ((d) => opencodeLimits.collectGo(d));
  const fetchGoWeb = deps.opencodeFetchGoWeb || ((cookie, d) => opencodeWeb.fetchGoWeb(cookie, d));
  const fetchZen = deps.opencodeFetchZen || ((cookie, d) => opencodeWeb.fetchZen(cookie, d));

  // Determine cookie sources: explicit profiles > legacy single cookie > env var
  const explicitProfiles = options.opencodeProfiles;
  const envCookie = (deps.env || process.env).TOKEN_MONITOR_OPENCODE_COOKIE || '';

  let cookies = [];
  if (explicitProfiles && Object.keys(explicitProfiles).length > 0) {
    for (const [name, p] of Object.entries(explicitProfiles)) {
      if (p.enabled && p.cookie) cookies.push({ name, cookie: p.cookie });
    }
  } else if (options.opencodeCookie) {
    cookies = [{ name: 'default', cookie: options.opencodeCookie }];
  }

  // Env var — show only if its cookie isn't already in a profile
  if (envCookie && !cookies.some((c) => c.cookie === envCookie)) {
    cookies.push({ name: 'default (env)', cookie: envCookie });
  }

  const multiAccountMode = cookies.length > 1;
  const scope = options.limitRefreshScope?.provider === 'opencode'
    ? options.limitRefreshScope
    : null;
  if (scope && multiAccountMode) {
    const profileName = scope.accountName || scope.accountLabel;
    cookies = profileName
      ? cookies.filter(({ name }) => name === profileName)
      : [];
  }

  // ── Single account (0 or 1 cookie): existing merged behavior ─────────────
  if (!multiAccountMode) {
    const goLocal = collectGo({ env: deps.env || process.env, now: () => nowMs });
    const cookie = cookies[0]?.cookie;
    const [goWeb, zen] = cookie
      ? await Promise.all([
          fetchGoWeb(cookie, { now: () => nowMs }),
          fetchZen(cookie, { now: () => nowMs, workspaceId: '' })
        ])
      : [null, null];

    const windows = [];
    let status = 'notConfigured';
    let source = 'local';
    let accountLabel = '';
    let accountKey = '';
    let balanceUsd = null;

    if (goWeb && goWeb.status === 'ok' && goWeb.windows.length > 0) {
      windows.push(...goWeb.windows);
      status = 'ok'; source = 'web'; accountLabel = 'Go';
      accountKey = hashKey('opencode', `go:${goWeb.workspaceId || ''}`);
    } else if (goLocal.status === 'ok') {
      windows.push(...goLocal.windows);
      status = 'ok'; accountLabel = 'Go';
      accountKey = hashKey('opencode', goLocal.identity || 'go');
    } else if (goLocal.status === 'unavailable') {
      status = 'unavailable';
    }

    if (zen && zen.status === 'ok') {
      windows.push(...zen.windows);
      status = 'ok'; source = 'web';
      if (typeof zen.balanceUsd === 'number' && Number.isFinite(zen.balanceUsd)) balanceUsd = zen.balanceUsd;
      if (!accountLabel) accountLabel = 'Zen';
      if (!accountKey) accountKey = hashKey('opencode', `zen:${zen.workspaceId || ''}`);
    } else if (status !== 'ok') {
      const webFail = ['unauthorized', 'sourceRateLimited', 'unavailable'];
      const surfaced = (goWeb && webFail.includes(goWeb.status) && goWeb.status)
        || (zen && webFail.includes(zen.status) && zen.status);
      if (surfaced) { status = surfaced; source = 'web'; }
    }

    return normalizeLimitProvider({ provider: 'opencode', accountKey, accountLabel, source, status, updatedAt, windows, balanceUsd });
  }

  // ── Multi-account (2+ cookies): separate per-profile providers ────────────
  const providers = [];

  // Each enabled profile — query in parallel
  const results = await Promise.all(
    cookies.map(({ name, cookie }) =>
      fetchSingleOpenCodeProfile(name, cookie, fetchGoWeb, fetchZen, nowMs, updatedAt)
    )
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

async function fetchSingleOpenCodeProfile(name, cookie, fetchGoWeb, fetchZen, nowMs, updatedAt) {
  const PROFILE_TIMEOUT_MS = 15000;
  let timer;

  try {
    const result = await Promise.race([
      (async () => {
        const [goWeb, zen] = await Promise.all([
          fetchGoWeb(cookie, { now: () => nowMs }),
          fetchZen(cookie, { now: () => nowMs, workspaceId: '' })
        ]);
        return { goWeb, zen };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), PROFILE_TIMEOUT_MS);
      })
    ]);
    clearTimeout(timer);

    const { goWeb, zen } = result;
    const windows = [];
    let status = 'notConfigured';
    let planLabel = '';
    let balanceUsd = null;

    if (goWeb && goWeb.status === 'ok' && goWeb.windows.length > 0) {
      windows.push(...goWeb.windows);
      status = 'ok';
      planLabel = 'Go';
    }

    if (zen && zen.status === 'ok') {
      windows.push(...zen.windows);
      status = 'ok';
      if (!planLabel) planLabel = 'Zen';
      if (typeof zen.balanceUsd === 'number' && Number.isFinite(zen.balanceUsd)) balanceUsd = zen.balanceUsd;
    }

    if (status !== 'ok') {
      const failStatus = goWeb?.status || zen?.status || 'unauthorized';
      status = failStatus;
    }

    // Stable accountKey derived from workspaceId (preferred) or cookie hash,
    // not from the user-editable profile name — so the same account is
    // consistently identified across machines and renames.
    const goWid = goWeb?.workspaceId || '';
    const zenWid = zen?.workspaceId || '';
    let accountKey;
    if (goWeb && goWeb.status === 'ok' && goWid) {
      accountKey = hashKey('opencode', `go:${goWid}`);
    } else if (zen && zen.status === 'ok' && zenWid) {
      accountKey = hashKey('opencode', `zen:${zenWid}`);
    } else {
      const cookieHash = crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 12);
      accountKey = hashKey('opencode', `cookie:${cookieHash}`);
    }

    return normalizeLimitProvider({
      provider: 'opencode',
      accountKey,
      accountName: name,
      // Keep accountLabel as the profile name for pre-accountName renderers.
      // New renderers use planLabel for Go/Zen and accountName for identity.
      accountLabel: name,
      planLabel,
      source: 'web',
      status,
      updatedAt,
      windows,
      balanceUsd
    });
  } catch {
    clearTimeout(timer);
    const cookieHash = crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 12);
    return normalizeLimitProvider({
      provider: 'opencode', accountKey: hashKey('opencode', `cookie:${cookieHash}`),
      accountName: name, accountLabel: name, planLabel: '', source: 'web', status: 'unavailable',
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
    const storePath = deps.deepseekStorePath || path.join(sharedDataDir({ env }), 'deepseek-balance.json');
    const spend = recordConsumption(
      { accountKey, currency: row.currency, paid: row.paid, now, storePath },
      deps
    );
    return normalizeLimitProvider({
      provider: 'deepseek',
      accountKey,
      accountLabel: 'Pay-as-you-go',
      source: 'api',
      status: 'ok',
      updatedAt: nowIso(now),
      windows: [],
      balance: {
        amount: row.amount,
        currency: row.currency,
        todaySpend: spend.todaySpend,
        monthSpend: spend.monthSpend,
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
    deepseek: (providerOptions, probeDeps) => fetchDeepSeekLimits(providerOptions, probeDeps),
    minimax: (providerOptions, probeDeps) => minimaxLimits.fetchMinimaxLimits(providerOptions, probeDeps),
    mimo: (providerOptions, probeDeps) => fetchMimoLimits(providerOptions, probeDeps),
    grok: (providerOptions, probeDeps) => grokLimits.fetchGrokLimits(providerOptions, probeDeps),
    copilot: (providerOptions, probeDeps) => copilotLimits.fetchCopilotLimits(providerOptions, probeDeps),
    kiro: (providerOptions, probeDeps) => kiroLimits.fetchKiroLimits(providerOptions, probeDeps),
    zai: (providerOptions, probeDeps) => zaiLimits.fetchZaiLimits(providerOptions, probeDeps),
    zaiteam: (providerOptions, probeDeps) => zaiTeamLimits.fetchZaiTeamLimits(providerOptions, probeDeps),
    volcengine: (providerOptions, probeDeps) => volcengineLimits.fetchVolcengineLimits(providerOptions, probeDeps),
    qoder: (providerOptions, probeDeps) => qoderLimits.fetchQoderLimits(providerOptions, probeDeps),
    ollama: (providerOptions, probeDeps) => ollamaLimits.fetchOllamaLimits(providerOptions, probeDeps),
    kimi: (providerOptions, probeDeps) => kimiLimits.fetchKimiLimits(providerOptions, probeDeps),
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

async function probeLimitProvider(provider, options = {}, context = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const fetcher = providerFetchers(deps)[provider];
  if (!fetcher) return [statusProvider(provider, 'notConfigured', nowIso(nowMs))];
  try {
    const result = await fetcher(options, { ...deps, signal: context.signal ?? deps.signal });
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
  const runtime = createLimitsRuntime(options, { ...deps, autoStart: false });
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

  const result = await probe(account.sessionToken);
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
  DEFAULT_PROVIDER_PHYSICAL_BOUND_MS,
  PROVIDER_CLEANUP_GRACE_MS,
  collectLimitsOnce,
  claudeCommandCandidates,
  codexCommandCandidates,
  codexCommandSourceDetail,
  createLimitsCollector,
  probeLimitProvider,
  providerPhysicalBoundMs,
  fetchAntigravityLimits,
  fetchOpenCodeLimits,
  fetchSingleOpenCodeProfile,
  fetchClaudeLimits,
  fetchCodexLimits,
  fetchCursorLimits,
  fetchDeepSeekLimits,
  fetchMimoLimits,
  runCodexLogin,
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
  normalizeLimitsRefreshMs,
  refreshClaudeAccessToken,
  refreshClaudeCredentials,
  delegatedClaudeRefresh,
  touchClaudeAuthPath,
  rankClaudeCredentialFiles,
  wslClaudeCredentialPaths
};
