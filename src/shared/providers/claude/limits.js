'use strict';

// Claude limits provider: OAuth and Web session credentials, the CLI fallback,
// identity/prepaid caches, and the usage → provider-window mapping. Reached
// through providerFetchers() in src/shared/limits/collector.js, which re-exports
// the handful of names the widget and the tests use.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');
const { normalizeLimitProvider } = require('../../limits/core');
const { abortError } = require('../../probeDeadline');
const { hashKey } = require('../../hashKey');
const {
  PLAN_LABEL_ALIASES,
  TOKEN_MONITOR_USER_AGENT,
  cleanPlanText,
  envValue,
  errorWithStatus,
  fetchJson,
  nowIso,
  parseBoolean,
  pathApiForPlatform,
  pathDelimiterForPlatform,
  planLabelFromParts,
  runProcessText,
  uniqueStrings
} = require('../../limits/providerHelpers');

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

module.exports = {
  claudeCommandCandidates,
  claudeWebCookie,
  delegatedClaudeRefresh,
  fetchClaudeLimits,
  mapClaudeCliUsageToProvider,
  mapClaudeUsageToProvider,
  normalizeClaudeWebCookieInput,
  parseClaudeCliUsageText,
  rankClaudeCredentialFiles,
  refreshClaudeAccessToken,
  refreshClaudeCredentials,
  touchClaudeAuthPath,
  wslClaudeCredentialPaths
};
