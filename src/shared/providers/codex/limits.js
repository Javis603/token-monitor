'use strict';

// Codex limits provider: ChatGPT/Codex backend usage, the CLI RPC fallback and
// login flow, managed-account normalization, and the rate-limit → provider-window
// mapping. Account identity itself lives in ./auth.js, which the widget also uses
// directly. Reached through providerFetchers() in src/shared/limits/collector.js.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appVersion } = require('../../appVersion');
const { normalizeLimitProvider } = require('../../limits/core');
const { abortError } = require('../../probeDeadline');
const {
  codexAccountKey,
  codexAuthIdentity,
  codexOAuthRequestContext,
  codexStoredAccountId
} = require('./auth');
const { hashKey } = require('../../hashKey');
const {
  TOKEN_MONITOR_USER_AGENT,
  cleanPlanText,
  displayPlanText,
  envValue,
  errorWithStatus,
  fetchJson,
  nowIso,
  pathApiForPlatform,
  pathDelimiterForPlatform,
  providerStatusFromError,
  uniqueStrings
} = require('../../limits/providerHelpers');

const CODEX_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_BACKEND_PATHS = Object.freeze({
  chatgpt: Object.freeze({
    usage: '/wham/usage',
    resetCredits: '/wham/rate-limit-reset-credits'
  }),
  codex: Object.freeze({
    usage: '/api/codex/usage',
    resetCredits: '/api/codex/rate-limit-reset-credits'
  })
});
const CODEX_EMPTY_QUOTA_RETRY_DELAY_MS = 300;
const CODEX_RPC_TIMEOUT_MS = 20_000;
function codexAuthPath(env = process.env) {
  const base = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(base, 'auth.json');
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

function codexWindowKind(name, window) {
  const mins = Number(window?.windowDurationMins || window?.window_duration_mins || 0);
  // Monthly quotas use the shared wire contract's billing lane. The display
  // label below keeps the cadence explicit instead of presenting it as money.
  if (mins === 30 * 24 * 60) return 'billing';
  if (mins >= 7 * 24 * 60) return 'weekly';
  if (mins >= 24 * 60) return 'daily';
  if (mins === 5 * 60) return 'session';
  if (String(name).toLowerCase() === 'secondary') return 'weekly';
  return 'session';
}

function codexAdditionalRateLimitWindows(payload = {}) {
  const rateLimitsById = codexRateLimitsById(payload);
  const direct = codexDirectRateLimits(payload);
  // A named bucket is additive only when a canonical quota source exists. If
  // an old RPC response has nothing but alternate buckets, codexRateLimitSnapshot
  // may use their consensus as the main quota; publishing them again here would
  // duplicate the same numbers as both ordinary and additional windows.
  if (!Object.hasOwn(rateLimitsById, 'codex') && !hasCodexRateLimitWindows(direct)) return [];

  const windows = [];
  for (const [limitId, snapshot] of Object.entries(rateLimitsById)) {
    if (limitId === 'codex' || !snapshot || typeof snapshot !== 'object') continue;
    const limitName = String(snapshot.limitName ?? snapshot.limit_name ?? '').trim() || String(limitId).trim();
    if (!limitName) continue;
    for (const key of ['primary', 'secondary']) {
      const window = snapshot[key];
      if (!window) continue;
      windows.push({
        kind: codexWindowKind(key, window),
        label: limitName,
        limitId,
        additional: true,
        usedPercent: window.usedPercent ?? window.used_percent,
        resetsAt: window.resetsAt ?? window.resets_at,
        windowMinutes: window.windowDurationMins ?? window.window_duration_mins
      });
    }
  }
  return windows;
}

function hasCodexRateLimitWindows(snapshot) {
  return Boolean(snapshot && typeof snapshot === 'object' && (snapshot.primary || snapshot.secondary));
}

function codexRateLimitsById(payload = {}) {
  return payload.rateLimitsByLimitId || payload.rate_limits_by_limit_id || {};
}

function normalizeCodexUsageWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const seconds = Number(window.limitWindowSeconds ?? window.limit_window_seconds);
  return {
    ...window,
    usedPercent: window.usedPercent ?? window.used_percent,
    resetsAt: window.resetsAt ?? window.resetAt ?? window.reset_at,
    windowDurationMins: Number.isFinite(seconds) ? seconds / 60 : undefined
  };
}

function normalizeCodexUsageRateLimit(rateLimit, meta = {}) {
  const source = rateLimit && typeof rateLimit === 'object' ? rateLimit : {};
  const primary = normalizeCodexUsageWindow(source.primaryWindow || source.primary_window);
  const secondary = normalizeCodexUsageWindow(source.secondaryWindow || source.secondary_window);
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(meta.limitId ? { limitId: meta.limitId } : {}),
    ...(meta.limitName ? { limitName: meta.limitName } : {}),
    planType: meta.planType
  };
}

function normalizeCodexUsagePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const hasUsageShape = Object.hasOwn(payload, 'rateLimit')
    || Object.hasOwn(payload, 'rate_limit')
    || Object.hasOwn(payload, 'additionalRateLimits')
    || Object.hasOwn(payload, 'additional_rate_limits');
  if (!hasUsageShape) return payload;

  const planType = payload.planType ?? payload.plan_type;
  const rateLimit = payload.rateLimit ?? payload.rate_limit;
  const rateLimits = normalizeCodexUsageRateLimit(rateLimit, { limitId: 'codex', planType });
  const rateLimitsByLimitId = { ...codexRateLimitsById(payload), codex: rateLimits };
  const additional = payload.additionalRateLimits ?? payload.additional_rate_limits;
  for (const entry of Array.isArray(additional) ? additional : []) {
    if (!entry || typeof entry !== 'object') continue;
    const limitId = String(entry.meteredFeature ?? entry.metered_feature ?? '').trim();
    if (!limitId || limitId === 'codex') continue;
    rateLimitsByLimitId[limitId] = normalizeCodexUsageRateLimit(
      entry.rateLimit ?? entry.rate_limit,
      {
        limitId,
        limitName: String(entry.limitName ?? entry.limit_name ?? '').trim(),
        planType
      }
    );
  }

  return { ...payload, rateLimits, rateLimitsByLimitId };
}

function codexDirectRateLimits(payload = {}) {
  const direct = payload.rateLimits || payload.rate_limits;
  if (direct && typeof direct === 'object') return direct;
  const wham = payload.rateLimit || payload.rate_limit;
  if (!wham || typeof wham !== 'object') return {};
  return normalizeCodexUsageRateLimit(wham, { planType: payload.planType ?? payload.plan_type });
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
  // An explicit main bucket is authoritative even when it has no windows.
  // OAuth additional_rate_limits are independent metered-feature quotas; they
  // must never be promoted into the ordinary Codex session/weekly lanes. The
  // alternate consensus below remains only for legacy RPC payloads that omit
  // the canonical `codex` key entirely.
  if (Object.hasOwn(rateLimitsById, 'codex')) return rateLimitsById.codex || {};
  if (hasCodexRateLimitWindows(direct)) return direct;
  const alternate = unambiguousAlternateCodexRateLimits(rateLimitsById);
  if (alternate) return alternate;
  return direct || {};
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

function codexOAuthRequestHeaders(auth, deps = {}, extra = {}) {
  const context = codexOAuthRequestContext(auth, {
    accountId: deps.codexAccountId
  });
  const headers = {
    authorization: `Bearer ${context.accessToken}`,
    accept: 'application/json',
    'user-agent': TOKEN_MONITOR_USER_AGENT,
    ...extra
  };
  if (context.accountId) headers['chatgpt-account-id'] = context.accountId;
  if (context.isFedrampAccount) headers['x-openai-fedramp'] = 'true';
  return headers;
}

function readCodexOAuthAuth(deps = {}) {
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
  return { auth, accessToken };
}

function codexOAuthAuthSnapshot(deps = {}) {
  return deps.codexOAuthAuthSnapshot || readCodexOAuthAuth(deps);
}

async function fetchCodexUsage(deps = {}) {
  const { auth } = codexOAuthAuthSnapshot(deps);
  const headers = codexOAuthRequestHeaders(auth, deps);
  try {
    const baseUrl = codexChatGptBaseUrl(deps);
    const usagePath = codexBackendPaths(baseUrl).usage;
    return await fetchJson(
      `${baseUrl}${usagePath}`,
      headers,
      { ...deps, fetchTimeoutMs: deps.codexUsageTimeoutMs || 30_000 },
      { forbiddenIsUnauthorized: true }
    );
  } catch (error) {
    if (error?.status === 'unauthorized') error.code = 'CODEX_OAUTH_HTTP_UNAUTHORIZED';
    throw error;
  }
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

function codexBackendPathStyle(baseUrl) {
  return String(baseUrl || '').includes('/backend-api') ? 'chatgpt' : 'codex';
}

function codexBackendPaths(baseUrl) {
  return CODEX_BACKEND_PATHS[codexBackendPathStyle(baseUrl)];
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
  const { auth } = codexOAuthAuthSnapshot(deps);

  const fetchFn = deps.fetch || fetch;
  const timeoutMs = Number(deps.codexResetCreditsTimeoutMs || 4000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const baseUrl = codexChatGptBaseUrl(deps);
  const url = `${baseUrl}${codexBackendPaths(baseUrl).resetCredits}`;
  try {
    const headers = codexOAuthRequestHeaders(auth, deps, {
      'openai-beta': 'codex-1',
      originator: 'Codex Desktop'
    });
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

async function withCodexOAuthResetCredits(payload, deps = {}, oauthAuthSnapshot = null) {
  const existing = codexResetCreditsSnapshot(payload);
  try {
    const resetDeps = oauthAuthSnapshot ? { ...deps, codexOAuthAuthSnapshot: oauthAuthSnapshot } : deps;
    const oauthResetCredits = await readCodexResetCredits(resetDeps);
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
  const canonicalLimitId = String(rateLimits.limitId ?? rateLimits.limit_id ?? 'codex').trim() || 'codex';
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const window = rateLimits[key];
    if (!window) continue;
    const kind = codexWindowKind(key, window);
    windows.push({
      kind,
      ...(kind === 'billing' ? { label: 'Monthly' } : {}),
      limitId: canonicalLimitId,
      usedPercent: window.usedPercent ?? window.used_percent,
      resetsAt: window.resetsAt ?? window.resets_at,
      windowMinutes: window.windowDurationMins ?? window.window_duration_mins
    });
  }
  windows.push(...codexAdditionalRateLimitWindows(payload));
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
  const args = ['-s', 'read-only', '-a', 'never', 'app-server'];
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args };
  }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', [quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(' ')]
  };
}

// Windows parses a quoted argument by the CRT rule that a run of backslashes is
// literal unless it precedes a quote, where the run must be doubled. Escaping
// only the quote leaves a trailing backslash escaping the closing quote, so the
// argument bleeds into the next one. Neither call site below can reach that
// today — their args are fixed safe words and a command that ends in .cmd/.bat
// cannot end in a backslash — but the rule belongs in the quoter, not in an
// assumption about who calls it.
function quoteWindowsCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(text)) return text;
  const escaped = text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
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
  let transportError = null;
  const pending = new Map();

  function rejectAll(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  function failTransport(error) {
    if (closed) return;
    closed = true;
    transportError = error;
    rejectAll(error);
  }

  function failRetryableTransport(error) {
    const target = error instanceof Error ? error : new Error(String(error || 'codex app-server transport failed'));
    target.codexTransportFailure = true;
    failTransport(target);
  }

  function abort(error) {
    failTransport(error);
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
  child.on('error', failRetryableTransport);
  child.on('close', (code) => failRetryableTransport(new Error(`codex app-server exited ${code}`)));
  child.stdin.on?.('error', failRetryableTransport);

  function writeLine(line) {
    if (closed) return;
    try {
      child.stdin.write(line, (error) => {
        if (error) failRetryableTransport(error);
      });
    } catch (error) {
      failRetryableTransport(error);
    }
  }

  function send(method, params) {
    if (closed) return Promise.reject(transportError || new Error('codex app-server is closed'));
    const id = nextId++;
    const message = params === undefined ? { method, id } : { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      writeLine(`${JSON.stringify(message)}\n`);
    });
  }

  function notify(method, params) {
    writeLine(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  return { abort, send, notify, rejectAll };
}

function shouldTryNextCodexCommand(error) {
  if (error?.codexTransportFailure) return true;
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
    let accountReadError = null;
    const accountResult = await rpc.send('account/read', { refreshToken: false }).catch((error) => {
      if (signal?.aborted) throw abortError(signal);
      accountReadError = error;
      return null;
    });
    const account = accountResult?.account || null;
    let payload = codexRpcPayload(rateLimitResult, account, command, deps);
    if (
      accountReadError &&
      !hasCodexRateLimitWindows(codexRateLimitSnapshot(payload)) &&
      accountReadError.codexTransportFailure
    ) {
      throw accountReadError;
    }
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
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (error?.codexTransportFailure) throw error;
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
    account.workspaceAccountId
    || account.providerAccountId
    || authIdentity.workspaceAccountId
    || authIdentity.providerAccountId
    || ''
  ).trim().toLowerCase();
  return resolvedCodexAccountKey(
    email,
    workspaceAccountId,
    account.accountKey || authIdentity.accountKey || email || account.id || account.homePath
  );
}

function codexManagedRpcMatchesSelectedWorkspace(deps = {}, oauthAuthSnapshot = null) {
  const selectedWorkspaceId = String(deps.codexAccountId || '').trim().toLowerCase();
  if (!selectedWorkspaceId) return true;
  const storedWorkspaceId = String(
    codexStoredAccountId(oauthAuthSnapshot?.auth)
    || deps.codexRpcStoredAccountId
    || ''
  ).trim().toLowerCase();
  return Boolean(storedWorkspaceId && storedWorkspaceId === selectedWorkspaceId);
}

function codexOAuthCanFallbackToRpc(error, deps = {}, managedRpcIsScoped = false) {
  if (
    (deps.codexAccountId && !managedRpcIsScoped)
    || deps.signal?.aborted
    || error?.code === 'ABORT_ERR'
    || error?.name === 'AbortError'
  ) return false;
  const httpStatus = Number(error?.httpStatus);
  if (Number.isFinite(httpStatus)) return httpStatus === 408 || httpStatus >= 500;
  return !['notConfigured', 'unauthorized', 'sourceRateLimited'].includes(error?.status);
}

async function readCodexUsageOrRpc(deps = {}) {
  const oauthReader = deps.readCodexUsage || fetchCodexUsage;
  const rpcReader = deps.readCodexRpc || readCodexRpc;
  let latestOAuthAuthSnapshot = null;
  const readOAuth = async () => {
    let oauthAuthSnapshot = null;
    try {
      oauthAuthSnapshot = readCodexOAuthAuth(deps);
    } catch (error) {
      if (oauthReader === fetchCodexUsage) throw error;
    }
    latestOAuthAuthSnapshot = oauthAuthSnapshot;
    const oauthDeps = oauthAuthSnapshot ? { ...deps, codexOAuthAuthSnapshot: oauthAuthSnapshot } : deps;
    return {
      payload: normalizeCodexUsagePayload(await oauthReader(oauthDeps)),
      source: 'oauth',
      sourceDetail: '',
      oauthAuthSnapshot
    };
  };
  let oauthError;
  let transientRpcFallback;
  try {
    return await readOAuth();
  } catch (error) {
    oauthError = error;
    transientRpcFallback = codexOAuthCanFallbackToRpc(
      error,
      deps,
      codexManagedRpcMatchesSelectedWorkspace(deps, latestOAuthAuthSnapshot)
    );
    if (!['notConfigured', 'unauthorized'].includes(error?.status) && !transientRpcFallback) {
      error.codexSource = 'oauth';
      throw error;
    }
  }

  let rpcPayload;
  try {
    rpcPayload = await rpcReader(deps);
  } catch (error) {
    if (transientRpcFallback) {
      oauthError.codexSource = 'oauth';
      throw oauthError;
    }
    error.codexSource = 'rpc';
    throw error;
  }
  const managedRpcIsScoped = codexManagedRpcMatchesSelectedWorkspace(
    deps,
    latestOAuthAuthSnapshot
  );
  // A managed app-server result is usable only when its isolated auth snapshot
  // is already scoped to the selected workspace. Otherwise RPC remains
  // recovery-only and the explicitly scoped OAuth request must succeed.
  if (deps.codexAccountId || oauthError?.code === 'CODEX_OAUTH_HTTP_UNAUTHORIZED') {
    try {
      return await readOAuth();
    } catch (retryError) {
      if (deps.codexAccountId && !managedRpcIsScoped) {
        retryError.codexSource = 'oauth';
        throw retryError;
      }
    }
  }
  return { payload: rpcPayload, source: 'rpc', sourceDetail: rpcPayload.sourceDetail };
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
    codexAuthPath: account.authPath || pathApi.join(account.homePath, 'auth.json'),
    codexAccountId: account.workspaceAccountId || undefined
  };
  const initialAuth = readLiveCodexAuth(accountDeps);
  const initialAuthIdentity = initialAuth
    ? codexAuthIdentity(initialAuth)
    : { email: '', accountLabel: '', providerAccountId: '', accountKey: '' };
  accountDeps.codexRpcStoredAccountId = codexStoredAccountId(initialAuth);
  try {
    const result = await readCodexUsageOrRpc(accountDeps);
    const payload = await withCodexOAuthResetCredits(result.payload, accountDeps, result.oauthAuthSnapshot);
    const authIdentity = result.oauthAuthSnapshot
      ? codexAuthIdentity(result.oauthAuthSnapshot.auth)
      : initialAuthIdentity;
    const email = account.email || authIdentity.email || payload.account?.email;
    return mapCodexRateLimitsToProvider(payload, {
      accountKey: managedCodexAccountKey(account, authIdentity, email),
      accountEmail: email,
      accountLabel: codexAccountLabel(payload) || account.accountLabel,
      accountName: account.workspaceLabel,
      workspaceKind: account.workspaceKind,
      updatedAt: nowIso(nowMs),
      source: result.source,
      sourceDetail: 'managed'
    });
  } catch (error) {
    const email = account.email || initialAuthIdentity.email;
    return normalizeLimitProvider({
      provider: 'codex',
      accountKey: managedCodexAccountKey(account, initialAuthIdentity, email),
      accountEmail: email,
      accountLabel: account.accountLabel,
      accountName: account.workspaceLabel,
      workspaceKind: account.workspaceKind,
      source: error.codexSource || 'oauth',
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
function readLiveCodexAuth(deps = {}) {
  const read = deps.readFileSync || fs.readFileSync;
  const authPath = deps.codexAuthPath || codexAuthPath(deps.env || process.env);
  try {
    return JSON.parse(read(authPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readLiveCodexIdentity(deps = {}) {
  const auth = readLiveCodexAuth(deps);
  return auth
    ? codexAuthIdentity(auth)
    : { email: '', accountLabel: '', providerAccountId: '', accountKey: '' };
}

async function fetchLiveCodexAccount(deps = {}, nowMs = Date.now(), managedAccounts = []) {
  const result = await readCodexUsageOrRpc(deps);
  const payload = await withCodexOAuthResetCredits(result.payload, deps, result.oauthAuthSnapshot);
  const authIdentity = result.oauthAuthSnapshot
    ? codexAuthIdentity(result.oauthAuthSnapshot.auth)
    : readLiveCodexIdentity(deps);
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
    source: result.source,
    sourceDetail: result.sourceDetail
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

module.exports = {
  codexCommandCandidates,
  quoteWindowsCmdArg,
  codexCommandSourceDetail,
  fetchCodexLimits,
  mapCodexRateLimitsToProvider,
  normalizeCodexManagedAccounts,
  readCodexRpcWithCommand,
  runCodexLogin
};
