'use strict';

const { normalizeLimitProvider } = require('../../limits/core');
const {
  cleanSecret,
  errorWithStatus,
  providerStatusFromError
} = require('../../limits/providerHelpers');
const { hashKey } = require('../../hashKey');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const OLLAMA_SETTINGS_URL = 'https://ollama.com/settings';
const OLLAMA_BALANCE_URL = 'https://ollama.com/api/balance';
const OLLAMA_ME_URL = 'https://ollama.com/api/me';
const VALIDATION_CACHE_MS = 30 * 1000;
const ACCOUNT_CACHE_MS = 6 * 60 * 60 * 1000;
const ACCOUNT_FAILURE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 4;
const SESSION_WINDOW_MINUTES = 5 * 60;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
let validationCache = null;
const accountCache = new Map();
const accountFailures = new Map();
const OLLAMA_SESSION_COOKIE_NAMES = new Set([
  'session',
  '__Secure-session',
  'ollama_session',
  '__Host-ollama_session',
  'wos-session',
  '__Secure-next-auth.session-token',
  'next-auth.session-token'
]);

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

function ollamaApiKey(env = process.env, options = {}) {
  const explicit = cleanSecret(options.ollamaApiKey);
  if (explicit) return explicit;
  for (const name of ['TOKEN_MONITOR_OLLAMA_API_KEY', 'OLLAMA_API_KEY']) {
    const key = cleanSecret(env[name]);
    if (key) return key;
  }
  return '';
}

function toIso(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function clampPercent(value) {
  if (value === null || value === undefined || value === '') return null;
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

// Only a web-lane success can prove a cookie; an API-lane probe must never seed
// this cache or a later cookie poll could answer with another account's row.
function rememberOllamaValidation(cookieHeader, provider, nowMs = Date.now()) {
  if (!cookieHeader) return;
  if (provider?.status !== 'ok' || provider?.source !== 'web') {
    if (validationCache?.key === validationCacheKey(cookieHeader)) validationCache = null;
    return;
  }
  const key = validationCacheKey(cookieHeader);
  if (validationCache?.key === key) validationCache = null;
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

const DOLLAR_AMOUNT = '(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]+)?';

function dollarAmount(text) {
  const value = Number(text.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function monthlyDollars(block) {
  const match = block.match(new RegExp(`>\\s*\\$(${DOLLAR_AMOUNT})\\s+of\\s+\\$(${DOLLAR_AMOUNT})\\s+used\\s*</`, 'i'));
  if (!match) return null;
  const used = dollarAmount(match[1]);
  const limit = dollarAmount(match[2]);
  if (used === null || limit === null || limit <= 0 || !Number.isFinite(used / limit * 100)) return null;
  return { metric: 'credits', label: 'Included credits', used, limit, remaining: Math.max(0, limit - used), currency: 'USD' };
}

function creditWalletWindows(text) {
  // Match complete elements within the wallet, never adjacent spend or prose.
  const heading = /<h[1-6]\b[^>]*>\s*Usage credits(?:\s*<span[^>]*>[^<]*<\/span\s*>)?\s*<\/h[1-6]\s*>/i.exec(text);
  if (!heading) return [];
  const tail = text.slice(heading.index + heading[0].length);
  const wallet = tail.split(/<\/section\s*>|<h[1-6]\b/i)[0];
  const balance = wallet.match(new RegExp(`^\\s*(?:<div[^>]*>\\s*)*<span[^>]*>\\s*\\$(${DOLLAR_AMOUNT})\\s*</span\\s*>`, 'i'));
  const spent = wallet.match(new RegExp(`<span[^>]*>\\s*Monthly credits used\\s*</span\\s*>\\s*<span[^>]*>\\s*\\$(${DOLLAR_AMOUNT})\\s*</span\\s*>`, 'i'));
  const refill = firstCapture(wallet, /<p[^>]*>\s*(Refills\s+to\s+\$[0-9,.]+\s+in\s+[^<]{1,160}?)\s*<\/p\s*>/i).trim();
  const windows = [];
  const remaining = balance ? dollarAmount(balance[1]) : null;
  const used = spent ? dollarAmount(spent[1]) : null;
  if (remaining !== null) windows.push({ kind: 'billing', metric: 'credits', label: 'Credit balance', remaining, currency: 'USD', showMeter: false, resetDescription: refill });
  if (used !== null) windows.push({ kind: 'billing', metric: 'spend', label: 'Monthly credits used', used, currency: 'USD', showMeter: false });
  return windows;
}

function parseOllamaUsageHtml(html) {
  const text = String(html || '')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ');
  // Monthly labels must be complete element text: "Free usage credits..."
  // and repeated aria descriptions are not separate usage blocks.
  const labelPattern = /(Session usage|Hourly usage|Weekly usage)|>\s*(Monthly usage|Free usage)\s*</gi;
  const labels = [];
  let match;
  while ((match = labelPattern.exec(text)) !== null) {
    labels.push({ index: match.index, label: match[1] || match[2] });
  }

  const windows = [];
  const seenKinds = new Set();
  const kindFor = (label) => /^weekly/i.test(label) ? 'weekly' : /^(monthly|free)/i.test(label) ? 'billing' : 'session';
  for (let index = 0; index < labels.length; index += 1) {
    const current = labels[index];
    const kind = kindFor(current.label);
    if (seenKinds.has(kind)) continue;
    const nextLabel = labels.slice(index + 1).find((candidate) => candidate.label.toLowerCase() !== current.label.toLowerCase());
    const end = nextLabel?.index ?? Math.min(text.length, current.index + 4000);
    const block = text.slice(current.index, Math.min(end, current.index + 4000))
      .split(/<h[1-6]\b[^>]*>\s*Usage credits/i)[0];
    const dollars = kind === 'billing' ? monthlyDollars(block) : null;
    const percentText = firstCapture(block, /([0-9]+(?:\.[0-9]+)?)\s*%\s*used/i)
      || firstCapture(block, /width\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
    const usedPercent = dollars ? clampPercent(dollars.used / dollars.limit * 100) : clampPercent(percentText);
    if (usedPercent === null) continue;
    windows.push({
      kind,
      ...(dollars || (kind === 'billing' ? { label: 'Monthly' } : {})),
      usedPercent,
      resetsAt: toIso(firstCapture(block, /data-time=["']([^"']+)["']/i)),
      ...(kind !== 'billing' ? { windowMinutes: kind === 'weekly' ? 7 * 24 * 60 : /^hourly/i.test(current.label) ? 60 : 5 * 60 } : {}),
      showMeter: true
    });
    seenKinds.add(kind);
  }

  windows.sort((a, b) => ({ session: 0, weekly: 1 }[a.kind] ?? 2) - ({ session: 0, weekly: 1 }[b.kind] ?? 2));
  windows.push(...creditWalletWindows(text));
  const planName = (firstCapture(text, /(?:Included usage|Cloud Usage)\s*<\/span\s*>\s*<span[^>]*>([^<]+)<\/span\s*>/i)
    || firstCapture(text, /<h[1-6][^>]*>\s*Usage credits\s*<span[^>]*>([^<]+)<\/span\s*>/i)).trim();
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

function finiteNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function usagePercentFromRemaining(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(Math.max(0, Math.min(100, 100 - number)) * 1000) / 1000;
}

/**
 * GET /api/balance contract (https://docs.ollama.com/api/balance).
 * Legacy plans carry included.session|weekly { remaining_percent, resets_at };
 * the new pricing returns included { balance_usd, allowance_usd, period } and
 * no 5-hour/weekly windows. `remaining_percent` is what is left, so the meter
 * value is its complement.
 */
function parseOllamaIncludedBalance(json) {
  const included = json && typeof json === 'object' && json.included && typeof json.included === 'object'
    ? json.included
    : null;
  if (!included) return null;
  const session = included.session && typeof included.session === 'object' ? included.session : null;
  const weekly = included.weekly && typeof included.weekly === 'object' ? included.weekly : null;
  if (session || weekly) {
    const windows = [];
    const sessionUsed = session ? usagePercentFromRemaining(session.remaining_percent) : null;
    if (sessionUsed !== null) {
      windows.push({
        kind: 'session',
        usedPercent: sessionUsed,
        resetsAt: toIso(session.resets_at),
        windowMinutes: SESSION_WINDOW_MINUTES,
        showMeter: true
      });
    }
    const weeklyUsed = weekly ? usagePercentFromRemaining(weekly.remaining_percent) : null;
    if (weeklyUsed !== null) {
      windows.push({
        kind: 'weekly',
        usedPercent: weeklyUsed,
        resetsAt: toIso(weekly.resets_at),
        windowMinutes: WEEKLY_WINDOW_MINUTES,
        showMeter: true
      });
    }
    if (windows.length) return { windows };
    return null;
  }
  const allowance = finiteNumber(included.allowance_usd);
  const balance = finiteNumber(included.balance_usd);
  if (allowance === null || allowance <= 0 || balance === null) return null;
  const remaining = Math.max(0, balance);
  const used = Math.max(0, Math.min(allowance, allowance - remaining));
  const period = included.period && typeof included.period === 'object' ? included.period : null;
  return {
    windows: [{
      kind: 'billing',
      metric: 'credits',
      label: 'Included credits',
      used,
      limit: allowance,
      remaining,
      currency: 'USD',
      resetsAt: toIso(period && period.until),
      showMeter: true
    }]
  };
}

function parseOllamaBalance(json) {
  const included = parseOllamaIncludedBalance(json);
  const windows = included?.windows || [];
  // JSON money accepts numbers and decimal strings, not coercible booleans,
  // arrays, whitespace or hexadecimal strings.
  const balance = finiteNumber(json?.purchased?.balance_usd);
  if (balance !== null) windows.push({ kind: 'billing', metric: 'credits', label: 'Credit balance', remaining: balance, currency: 'USD', showMeter: false });
  const allowance = finiteNumber(json?.included?.allowance_usd);
  const includedBalance = finiteNumber(json?.included?.balance_usd);
  const spent = allowance !== null && allowance >= 0 && includedBalance !== null ? Math.max(0, allowance - includedBalance) : null;
  if (spent !== null && Number.isFinite(spent)) windows.push({ kind: 'billing', metric: 'spend', label: 'Monthly credits used', used: spent, currency: 'USD', showMeter: false });
  return windows.length ? { windows } : null;
}

async function requestOllamaJson(url, init, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchFn(url, {
      ...init,
      redirect: 'manual',
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response || !response.ok) {
      const status = !response
        ? 'unavailable'
        : response.status === 401 || response.status === 403
          ? 'unauthorized'
          : response.status === 429
            ? 'sourceRateLimited'
            : 'unavailable';
      const error = errorWithStatus(status, `${url} returned ${response ? response.status : 'no response'}`);
      if (response) error.httpStatus = response.status;
      throw error;
    }
    try {
      return await response.json();
    } catch (_) {
      throw errorWithStatus('unavailable', `${url} returned invalid JSON`);
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw errorWithStatus('unavailable', `${url} timed out`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function apiKeyCacheKey(apiKey) {
  return hashKey('ollama-api-key', apiKey);
}

function fallbackAccountKey(apiKey) {
  return hashKey('ollama', `api-key:${apiKey}`);
}

function rememberAccount(keyHash, identity, nowMs) {
  accountCache.delete(keyHash);
  accountCache.set(keyHash, { ...identity, expiresAt: nowMs + ACCOUNT_CACHE_MS });
  while (accountCache.size > MAX_CACHE_ENTRIES) {
    accountCache.delete(accountCache.keys().next().value);
  }
}

function cachedAccount(keyHash, nowMs) {
  const cached = accountCache.get(keyHash);
  if (!cached) return null;
  if (cached.expiresAt <= nowMs) {
    accountCache.delete(keyHash);
    return null;
  }
  return cached;
}

// A failed lookup says nothing about the credential, so it must not be retried
// on every poll: a short negative cache keeps the extra request to once per
// failure window while the quota reading stays on the key-derived identity.
function rememberAccountFailure(keyHash, nowMs) {
  accountFailures.delete(keyHash);
  accountFailures.set(keyHash, nowMs + ACCOUNT_FAILURE_TTL_MS);
  while (accountFailures.size > MAX_CACHE_ENTRIES) {
    accountFailures.delete(accountFailures.keys().next().value);
  }
}

function accountFailureFresh(keyHash, nowMs) {
  const until = accountFailures.get(keyHash);
  if (!until) return false;
  if (until <= nowMs) {
    accountFailures.delete(keyHash);
    return false;
  }
  return true;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * The balance payload carries no identity, so a first-seen key asks the web
 * app's own session endpoint for the account email and plan. That endpoint is
 * undocumented: its fields are read case-insensitively, the answer is cached
 * for six hours, and a failure is not retried for five minutes. The email hash
 * matches the cookie lane's identity, so switching credential lanes or devices
 * does not split one account into two rows. A save probe passes `allowCache`
 * false so it can neither read nor seed this bookkeeping.
 */
async function resolveApiIdentity(apiKey, deps, nowMs, allowCache = true) {
  const keyHash = apiKeyCacheKey(apiKey);
  if (allowCache) {
    const cached = cachedAccount(keyHash, nowMs);
    if (cached) return cached;
    if (accountFailureFresh(keyHash, nowMs)) return null;
  }
  let data;
  try {
    data = await requestOllamaJson(OLLAMA_ME_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: '{}'
    }, deps);
  } catch (error) {
    if (allowCache) {
      if (error?.status === 'unauthorized') accountCache.delete(keyHash);
      rememberAccountFailure(keyHash, nowMs);
    }
    return null;
  }
  const email = firstText(data?.Email, data?.email).toLowerCase();
  if (!email || !email.includes('@')) {
    if (allowCache) rememberAccountFailure(keyHash, nowMs);
    return null;
  }
  const plan = firstText(data?.Plan, data?.plan);
  const identity = {
    accountKey: hashKey('ollama', email),
    accountEmail: email,
    accountLabel: plan
  };
  if (allowCache) {
    accountFailures.delete(keyHash);
    rememberAccount(keyHash, identity, nowMs);
  }
  return identity;
}

async function fetchOllamaApiLimits(apiKey, options, deps, nowMs, updatedAt) {
  let payload;
  try {
    payload = await requestOllamaJson(OLLAMA_BALANCE_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    }, deps);
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'ollama',
      source: 'api',
      status: providerStatusFromError(error),
      updatedAt,
      windows: []
    });
  }
  const parsed = parseOllamaBalance(payload);
  if (!parsed) {
    return normalizeLimitProvider({
      provider: 'ollama',
      source: 'api',
      status: 'unavailable',
      updatedAt,
      windows: []
    });
  }
  const allowCache = deps.probe !== true;
  // A save-time check only proves the key, so it stays one request: identity
  // resolution belongs to the poll that follows it.
  const identity = allowCache ? await resolveApiIdentity(apiKey, deps, nowMs, true) : null;
  const accountKey = identity ? identity.accountKey : fallbackAccountKey(apiKey);
  // Compare with rows the runtime accepted. A superseded probe can populate
  // the identity cache, but must not consume a removal before its result lands.
  const removals = allowCache ? (options.previousLimits?.providers || [])
    .filter((previous) => previous.provider === 'ollama' && previous.accountKey && previous.accountKey !== accountKey)
    .map((previous) => ({ provider: 'ollama', accountKey: previous.accountKey, removed: true })) : [];
  const row = normalizeLimitProvider({
    provider: 'ollama',
    accountKey,
    ...(identity?.accountEmail ? { accountEmail: identity.accountEmail } : {}),
    ...(identity?.accountLabel ? { accountLabel: identity.accountLabel } : {}),
    source: 'api',
    status: 'ok',
    updatedAt,
    windows: parsed.windows
  });
  return removals.length ? [row, ...removals] : row;
}

async function fetchOllamaLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const apiKey = ollamaApiKey(env, options);
  if (apiKey) return fetchOllamaApiLimits(apiKey, options, deps, now, updatedAt);

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
  OLLAMA_BALANCE_URL,
  OLLAMA_ME_URL,
  OLLAMA_SESSION_COOKIE_NAMES,
  normalizeOllamaCookieHeader,
  ollamaSessionCookie,
  ollamaApiKey,
  rememberOllamaValidation,
  parseOllamaUsageHtml,
  parseOllamaBalance,
  fetchOllamaLimits
};
