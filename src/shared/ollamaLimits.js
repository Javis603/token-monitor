'use strict';

const crypto = require('node:crypto');
const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { BROWSER_USER_AGENT } = require('./browserUserAgent');

const OLLAMA_SETTINGS_URL = 'https://ollama.com/settings';
const VALIDATION_CACHE_MS = 30 * 1000;
const OLLAMA_ACCOUNT_TIMEOUT_MS = 15_000;
let validationCache = null;
const OLLAMA_SESSION_COOKIE_NAMES = new Set([
  'session',
  '__Secure-session',
  'ollama_session',
  '__Host-ollama_session',
  'wos-session',
  '__Secure-next-auth.session-token',
  'next-auth.session-token'
]);

// In-memory usage-delta tracker: accountKey → { sessionPercent, weeklyPercent, lastChangedAt }
// Used to detect which account is actively sending tokens between polls.
const usageDeltaTracker = new Map();

function cleanSecret(value) {
  if (typeof value !== 'string') return '';
  let raw = value.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function cookiePairs(value) {
  let header = cleanSecret(value);
  if (/^cookie\s*:/i.test(header)) header = header.replace(/^cookie\s*:/i, '').trim();
  if (!header) return [];
  return header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    const validName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
    const validValue = cookieValue && !/[\u0000-\u001F\u007F]/.test(cookieValue);
    return validName && validValue ? { name, value: cookieValue } : null;
  }).filter(Boolean);
}

function isRecognizedSessionCookieName(name) {
  if (OLLAMA_SESSION_COOKIE_NAMES.has(name)) return true;
  return name.startsWith('__Secure-next-auth.session-token.')
    || name.startsWith('next-auth.session-token.');
}

function normalizeOllamaCookieHeader(rawCookie) {
  const cookie = cleanSecret(rawCookie);
  if (!cookie) return '';
  const pairs = cookiePairs(cookie);
  if (pairs.some((pair) => isRecognizedSessionCookieName(pair.name))) {
    return pairs.map((pair) => `${pair.name}=${pair.value}`).join('; ');
  }
  return '';
}

function ollamaSessionCookie(env = process.env, options = {}) {
  const explicit = normalizeOllamaCookieHeader(options.ollamaCookie);
  if (explicit) return explicit;
  for (const name of ['OLLAMA_COOKIE', 'TOKEN_MONITOR_OLLAMA_COOKIE']) {
    const header = normalizeOllamaCookieHeader(env[name]);
    if (header) return header;
  }
  return '';
}

function toIso(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function firstCapture(text, pattern) {
  return String(text || '').match(pattern)?.[1] || '';
}

function validationCacheKey(cookieHeader) {
  return hashKey('ollama-validation', cookieHeader);
}

function rememberOllamaValidation(cookieHeader, provider, nowMs = Date.now()) {
  if (!cookieHeader) return;
  const key = validationCacheKey(cookieHeader);
  if (validationCache?.key === key) validationCache = null;
  if (provider?.status !== 'ok') return;
  validationCache = {
    key,
    expiresAt: nowMs + VALIDATION_CACHE_MS,
    provider: normalizeLimitProvider(provider)
  };
}

function consumeOllamaValidation(cookieHeader, nowMs = Date.now()) {
  const key = validationCacheKey(cookieHeader);
  const cached = validationCache;
  if (!cached) return null;
  if (cached.expiresAt < nowMs) {
    validationCache = null;
    return null;
  }
  if (cached.key !== key) return null;
  validationCache = null;
  return cached.provider;
}

function parseOllamaUsageHtml(html) {
  const text = String(html || '');
  const labelPattern = /(Session usage|Hourly usage|Weekly usage)/gi;
  const labels = [];
  let match;
  while ((match = labelPattern.exec(text)) !== null) {
    labels.push({ index: match.index, label: match[1] });
  }

  const windows = [];
  const seenKinds = new Set();
  for (let index = 0; index < labels.length; index += 1) {
    const current = labels[index];
    const kind = /^weekly/i.test(current.label) ? 'weekly' : 'session';
    if (seenKinds.has(kind)) continue;
    const nextOtherKind = labels.slice(index + 1).find((candidate) => {
      const candidateKind = /^weekly/i.test(candidate.label) ? 'weekly' : 'session';
      return candidateKind !== kind;
    });
    const end = nextOtherKind?.index ?? Math.min(text.length, current.index + 4000);
    const block = text.slice(current.index, Math.min(end, current.index + 4000));
    const percentText = firstCapture(block, /([0-9]+(?:\.[0-9]+)?)\s*%\s*used/i)
      || firstCapture(block, /width\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
    const usedPercent = clampPercent(percentText);
    if (usedPercent === null) continue;
    windows.push({
      kind,
      usedPercent,
      resetsAt: toIso(firstCapture(block, /data-time=["']([^"']+)["']/i)),
      windowMinutes: kind === 'weekly' ? 7 * 24 * 60 : /^hourly/i.test(current.label) ? 60 : 5 * 60,
      showMeter: true
    });
    seenKinds.add(kind);
  }

  windows.sort((a, b) => ({ session: 0, weekly: 1 }[a.kind] ?? 2) - ({ session: 0, weekly: 1 }[b.kind] ?? 2));
  const planName = firstCapture(text, /Cloud Usage\s*<\/span\s*>\s*<span[^>]*>([^<]+)<\/span\s*>/i).trim();
  const accountEmail = firstCapture(text, /id=["']header-email["'][^>]*>([^<]+)</i).trim();
  return {
    windows,
    session: windows.find((window) => window.kind === 'session') || null,
    weekly: windows.find((window) => window.kind === 'weekly') || null,
    planName,
    accountEmail: accountEmail.includes('@') ? accountEmail.toLowerCase() : ''
  };
}

function looksSignedOut(html) {
  const lower = String(html || '').toLowerCase();
  const hasAuthRoute = lower.includes('/api/auth/signin') || lower.includes('/auth/signin')
    || lower.includes('href="/signin"') || lower.includes("href='/signin'")
    || lower.includes('action="/signin"') || lower.includes("action='/signin'")
    || lower.includes('href="/login"') || lower.includes("href='/login'")
    || lower.includes('action="/login"') || lower.includes("action='/login'");
  const hasEmail = lower.includes('type="email"') || lower.includes("type='email'")
    || lower.includes('name="email"') || lower.includes("name='email'");
  const hasPassword = lower.includes('type="password"') || lower.includes("type='password'")
    || lower.includes('name="password"') || lower.includes("name='password'");
  return lower.includes('<form') && (hasAuthRoute
    || lower.includes('sign in to ollama')
    || (hasEmail && hasPassword));
}

function redirectUrl(response, currentUrl) {
  const location = response?.headers?.get?.('location');
  if (!location) return null;
  try { return new URL(location, currentUrl); } catch (_) { return null; }
}

function isOllamaAuthUrl(url) {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if ((host === 'ollama.com' || host === 'www.ollama.com') && path === '/signin') return true;
  if (host === 'signin.ollama.com') return true;
  return host.endsWith('.workos.com') && path.startsWith('/user_management/authorize');
}

function shouldAttachOllamaCookie(url) {
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && (host === 'ollama.com' || host === 'www.ollama.com');
}

async function requestSettings(fetchFn, cookieHeader, controller) {
  let url = new URL(OLLAMA_SETTINGS_URL);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const response = await fetchFn(url, {
      headers: {
        ...(shouldAttachOllamaCookie(url) ? { Cookie: cookieHeader } : {}),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': BROWSER_USER_AGENT
      },
      redirect: 'manual',
      ...(controller ? { signal: controller.signal } : {})
    });
    if (response.status < 300 || response.status >= 400) return response;
    const nextUrl = redirectUrl(response, url);
    if (!nextUrl) throw errorWithStatus('unavailable', 'Ollama redirect missing Location');
    if (isOllamaAuthUrl(nextUrl)) throw errorWithStatus('unauthorized', 'Ollama session expired');
    if (!shouldAttachOllamaCookie(nextUrl)) {
      throw errorWithStatus('unavailable', 'Ollama redirected outside its HTTPS origin');
    }
    url = nextUrl;
  }
  throw errorWithStatus('unavailable', 'Ollama returned too many redirects');
}



function errorWithStatus(status, message) {
  const error = new Error(message || status);
  error.status = status;
  return error;
}

// ---------------------------------------------------------------------------
// Multi-account management helpers
// ---------------------------------------------------------------------------

function normalizeOllamaManagedAccounts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const accounts = [];
  for (const account of value) {
    if (!account || typeof account !== 'object') continue;
    const id = String(account.id || '').trim();
    const accountKey = String(account.accountKey || '').trim();
    if (!id || !accountKey) continue;
    if (seen.has(accountKey)) continue;
    seen.add(accountKey);
    accounts.push({
      id,
      accountKey,
      accountEmail: String(account.accountEmail || '').trim().slice(0, 254),
      accountLabel: String(account.accountLabel || '').trim(),
      addedAt: account.addedAt || new Date().toISOString(),
      updatedAt: account.updatedAt || account.addedAt || new Date().toISOString(),
      enabled: account.enabled !== false,
      // cookieHeader is ephemeral — loaded from credentialStore at runtime.
      // Pass it through if already resolved so fetchOllamaAccountWithTimeout
      // can use it without a second store lookup.
      ...(account.cookieHeader ? { cookieHeader: account.cookieHeader } : {})
    });
  }
  return accounts;
}

function createOllamaManagedAccount(cookieValue, existing = []) {
  const cookieHeader = normalizeOllamaCookieHeader(cookieValue);
  if (!cookieHeader) return { ok: false, errorCode: 'missingRequiredCookies' };
  // Derive a stable identity from the recognized session cookie pairs only,
  // sorted so that reordering or changing ancillary cookies does not change
  // the key (preventing the same session from being added multiple times).
  const identity = cookiePairs(cookieHeader)
    .filter((pair) => isRecognizedSessionCookieName(pair.name))
    .map((pair) => `${pair.name}=${pair.value}`)
    .sort()
    .join(';');
  const accountKey = hashKey('ollama', identity);
  const existingAccount = normalizeOllamaManagedAccounts(existing).find(
    (account) => account.accountKey === accountKey
  );
  const id = existingAccount?.id || crypto.randomUUID();
  return {
    ok: true,
    account: {
      id,
      accountKey,
      accountEmail: '',
      accountLabel: '',
      cookieHeader,
      addedAt: existingAccount?.addedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      enabled: true
    }
  };
}

function scopedOllamaManagedAccounts(value, scope = {}) {
  const accounts = normalizeOllamaManagedAccounts(value);
  if (!scope || typeof scope !== 'object') return accounts;
  const accountKey = String(scope.accountKey || '').trim();
  const accountEmail = String(scope.accountEmail || scope.email || '').trim().toLowerCase();
  const accountLabel = String(scope.accountLabel || scope.accountName || '').trim();
  if (!accountKey && !accountEmail && !accountLabel) return accounts;
  return accounts.filter((a) => {
    if (accountKey && a.accountKey === accountKey) return true;
    if (accountEmail && a.accountEmail.toLowerCase() === accountEmail) return true;
    if (accountLabel && a.accountLabel === accountLabel) return true;
    return false;
  });
}

// ---------------------------------------------------------------------------
// Active account detection via usage delta
// ---------------------------------------------------------------------------

function detectActiveOllamaAccount(results) {
  const now = Date.now();
  let activeCandidateKey = null;
  let activeCandidateAt = 0;

  // First pass: detect which account's usage increased since the last poll.
  for (const provider of results) {
    if (provider.status !== 'ok' || !provider.accountKey) continue;
    const sessionWindow = (provider.windows || []).find((w) => w.kind === 'session');
    const weeklyWindow = (provider.windows || []).find((w) => w.kind === 'weekly');
    const sessionPct = sessionWindow?.usedPercent ?? null;
    const weeklyPct = weeklyWindow?.usedPercent ?? null;

    const previous = usageDeltaTracker.get(provider.accountKey);
    const hadDelta = previous && (
      (sessionPct !== null && previous.sessionPercent !== null && sessionPct > previous.sessionPercent) ||
      (weeklyPct !== null && previous.weeklyPercent !== null && weeklyPct > previous.weeklyPercent)
    );

    // Update tracker
    usageDeltaTracker.set(provider.accountKey, {
      sessionPercent: sessionPct,
      weeklyPercent: weeklyPct,
      lastChangedAt: hadDelta ? now : (previous?.lastChangedAt || 0)
    });

    if (hadDelta) {
      const changedAt = usageDeltaTracker.get(provider.accountKey)?.lastChangedAt || 0;
      if (changedAt > activeCandidateAt) {
        activeCandidateKey = provider.accountKey;
        activeCandidateAt = changedAt;
      }
    }
  }

  // If no delta found on this poll, fall back to the most recently changed account.
  if (!activeCandidateKey) {
    let bestAt = 0;
    for (const provider of results) {
      if (provider.status !== 'ok' || !provider.accountKey) continue;
      const entry = usageDeltaTracker.get(provider.accountKey);
      const changedAt = entry?.lastChangedAt || 0;
      if (changedAt > bestAt) {
        bestAt = changedAt;
        activeCandidateKey = provider.accountKey;
      }
    }
  }

  // Tag the winner with activeAccount: true.
  for (const provider of results) {
    provider.activeAccount = Boolean(activeCandidateKey && provider.accountKey === activeCandidateKey);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Per-account fetch with timeout (for managed-accounts fan-out)
// ---------------------------------------------------------------------------

async function fetchOllamaAccountWithTimeout(account, deps = {}) {
  const timeoutMs = Number(deps.accountTimeoutMs || OLLAMA_ACCOUNT_TIMEOUT_MS);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const now = (deps.now || Date.now)();
    const updatedAt = new Date(now).toISOString();
    const cookieHeader = account.cookieHeader;
    if (!cookieHeader) {
      return normalizeLimitProvider({
        provider: 'ollama',
        source: 'web',
        status: 'notConfigured',
        updatedAt,
        windows: []
      });
    }
    const fetchFn = deps.fetch || fetch;
    const response = await requestSettings(fetchFn, cookieHeader, controller);
    if (response.status === 401 || response.status === 403) {
      throw errorWithStatus('unauthorized', `Ollama settings returned ${response.status}`);
    }
    if (response.status === 429) throw errorWithStatus('sourceRateLimited', 'Ollama settings returned 429');
    if (!response.ok) throw errorWithStatus('unavailable', `Ollama settings returned ${response.status}`);
    const html = await response.text();
    const parsed = parseOllamaUsageHtml(html);
    if (parsed.windows.length === 0) {
      throw errorWithStatus(
        looksSignedOut(html) ? 'unauthorized' : 'unavailable',
        'Ollama settings page had no usage meters'
      );
    }
    const email = parsed.accountEmail || account.accountEmail || '';
    const resolvedAccountKey = account.accountKey ||
      hashKey('ollama', email || cookiePairs(cookieHeader)
        .filter((pair) => isRecognizedSessionCookieName(pair.name))
        .map((pair) => `${pair.name}=${pair.value}`).join(';'));
    return normalizeLimitProvider({
      provider: 'ollama',
      accountKey: resolvedAccountKey,
      accountEmail: email,
      accountLabel: parsed.planName || account.accountLabel || '',
      source: 'web',
      status: 'ok',
      updatedAt,
      activeAccount: false,
      windows: parsed.windows
    });
  } catch (error) {
    const now = (deps.now || Date.now)();
    return normalizeLimitProvider({
      provider: 'ollama',
      accountKey: account.accountKey,
      source: 'web',
      status: error?.name === 'AbortError' ? 'unavailable' : (error?.status || 'unavailable'),
      updatedAt: new Date(now).toISOString(),
      windows: []
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Updated fetchOllamaLimits — fans out when ollamaManagedAccounts is set
// ---------------------------------------------------------------------------

async function fetchOllamaLimits(options = {}, deps = {}) {
  // --- Multi-account path ---
  const rawManaged = options.ollamaManagedAccounts || deps.ollamaManagedAccounts;
  const managedAccounts = normalizeOllamaManagedAccounts(rawManaged);
  const enabledAccounts = managedAccounts.filter((a) => a.enabled !== false);
  if (enabledAccounts.length > 0) {
    const scope = options.limitRefreshScope;
    const scoped = scope?.provider === 'ollama' && scopedOllamaManagedAccounts(enabledAccounts, scope);
    const targets = (scoped && scoped.length > 0) ? scoped : enabledAccounts;
    const results = await Promise.all(targets.map((account) => fetchOllamaAccountWithTimeout(account, deps)));
    return detectActiveOllamaAccount(results);
  }

  // --- Legacy single-cookie path (unchanged) ---
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const cookieHeader = ollamaSessionCookie(env, options);
  if (!cookieHeader) {
    return normalizeLimitProvider({ provider: 'ollama', source: 'web', status: 'notConfigured', updatedAt, windows: [] });
  }

  if (!deps.bypassValidationCache) {
    const cached = consumeOllamaValidation(cookieHeader, now);
    if (cached) return cached;
  }

  const fetchFn = deps.fetch || fetch;
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await requestSettings(fetchFn, cookieHeader, controller);
    if (response.status === 401 || response.status === 403) {
      throw errorWithStatus('unauthorized', `Ollama settings returned ${response.status}`);
    }
    if (response.status === 429) throw errorWithStatus('sourceRateLimited', 'Ollama settings returned 429');
    if (!response.ok) throw errorWithStatus('unavailable', `Ollama settings returned ${response.status}`);
    const html = await response.text();
    const parsed = parseOllamaUsageHtml(html);
    if (parsed.windows.length === 0) {
      throw errorWithStatus(looksSignedOut(html) ? 'unauthorized' : 'unavailable', 'Ollama settings page had no usage meters');
    }
    const identity = parsed.accountEmail || cookiePairs(cookieHeader)
      .filter((pair) => isRecognizedSessionCookieName(pair.name))
      .map((pair) => `${pair.name}=${pair.value}`).join(';');
    return normalizeLimitProvider({
      provider: 'ollama',
      accountKey: hashKey('ollama', identity),
      accountEmail: parsed.accountEmail,
      accountLabel: parsed.planName,
      source: 'web',
      status: 'ok',
      updatedAt,
      windows: parsed.windows
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'ollama',
      source: 'web',
      status: error?.name === 'AbortError' ? 'unavailable' : (error?.status || 'unavailable'),
      updatedAt,
      windows: []
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  OLLAMA_SETTINGS_URL,
  OLLAMA_SESSION_COOKIE_NAMES,
  normalizeOllamaCookieHeader,
  ollamaSessionCookie,
  rememberOllamaValidation,
  parseOllamaUsageHtml,
  fetchOllamaLimits,
  normalizeOllamaManagedAccounts,
  createOllamaManagedAccount,
  scopedOllamaManagedAccounts
};
