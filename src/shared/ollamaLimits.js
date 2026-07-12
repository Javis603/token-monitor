'use strict';

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');

const OLLAMA_SETTINGS_URL = 'https://ollama.com/settings';
const OLLAMA_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const VALIDATION_CACHE_MS = 30 * 1000;
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
        'User-Agent': OLLAMA_USER_AGENT
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

async function fetchOllamaLimits(options = {}, deps = {}) {
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

function errorWithStatus(status, message) {
  const error = new Error(message || status);
  error.status = status;
  return error;
}

module.exports = {
  OLLAMA_SETTINGS_URL,
  OLLAMA_SESSION_COOKIE_NAMES,
  normalizeOllamaCookieHeader,
  ollamaSessionCookie,
  rememberOllamaValidation,
  parseOllamaUsageHtml,
  fetchOllamaLimits
};
